// QR reading from the camera or an image. Uses the native BarcodeDetector when it supports QR codes,
// otherwise jsQR (lazy-loaded, cached for offline use by the service worker).

type Decode = (canvas: HTMLCanvasElement) => Promise<string | null>;

interface DetectedCode {
  rawValue: string;
  boundingBox: DOMRectReadOnly;
}
interface NativeDetector {
  detect(source: CanvasImageSource): Promise<DetectedCode[]>;
}

/** When several codes are visible, the one nearest the center of the image is the one meant. */
export function nearestToCenter<T extends { boundingBox: { x: number; y: number; width: number; height: number } }>(
  codes: T[],
  size: { width: number; height: number },
): T {
  const dist = (b: T['boundingBox']) =>
    Math.hypot(b.x + b.width / 2 - size.width / 2, b.y + b.height / 2 - size.height / 2);
  return codes.reduce((best, c) => (dist(c.boundingBox) < dist(best.boundingBox) ? c : best));
}
interface NativeDetectorCtor {
  new (opts: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}

async function jsqrDecoder(): Promise<Decode> {
  const { default: jsQR } = await import('jsqr');
  return async (canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // attemptBoth also reads light-on-dark (inverted) codes.
    const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    return r ? r.data : null;
  };
}

let decoderPromise: Promise<Decode> | null = null;

export function getDecoder(): Promise<Decode> {
  decoderPromise ??= (async () => {
    const BD = (globalThis as unknown as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
    if (BD) {
      try {
        if ((await BD.getSupportedFormats()).includes('qr_code')) {
          const native = new BD({ formats: ['qr_code'] });
          const fallback = await jsqrDecoder();
          let frame = 0;
          return async (canvas) => {
            const r = await native.detect(canvas);
            if (r.length) return nearestToCenter(r, canvas).rawValue;
            // Native detectors often skip inverted codes; try jsQR on every few frames.
            return ++frame % 4 === 0 ? fallback(canvas) : null;
          };
        }
      } catch {
        /* fall through to jsQR */
      }
    }
    return jsqrDecoder();
  })();
  return decoderPromise;
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'videoinput');
}

export function cameraErrorMessage(err: unknown): string {
  const name = (err as DOMException)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow it in your browser’s site settings, or scan from an image.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera found. You can scan a code from an image instead.';
    case 'NotReadableError':
      return 'The camera is busy in another app. Close it and try again, or scan from an image.';
    default:
      return 'Couldn’t start the camera. You can scan a code from an image instead.';
  }
}

// ---------- zoom ----------
//
// Zoom uses the camera's own zoom first (optical on many phones; the browser exposes it as the
// `zoom` track capability, which may switch lenses), then adds digital zoom on top by decoding an
// enlarged crop of the frame. Only the viewfinder square is decoded, so zooming in also isolates
// one code when several are in view.

/** Extra digital zoom available beyond the camera's maximum. */
export const DIGITAL_ZOOM_MAX = 4;
/** Viewfinder square as a fraction of the camera view's height (keep in sync with .scan-frame). */
export const FRAME_FRACTION = 0.72;

export interface HardwareZoom {
  min: number;
  max: number;
  step: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function zoomRange(hw: HardwareZoom | null): { min: number; max: number } {
  return hw ? { min: hw.min, max: hw.max * DIGITAL_ZOOM_MAX } : { min: 1, max: DIGITAL_ZOOM_MAX };
}

/** Split a total zoom into camera zoom (used first, null if unsupported) and digital zoom. */
export function splitZoom(total: number, hw: HardwareZoom | null): { hardware: number | null; digital: number } {
  if (!hw) return { hardware: null, digital: clamp(total, 1, DIGITAL_ZOOM_MAX) };
  let hardware = clamp(total, hw.min, hw.max);
  if (hw.step > 0) hardware = clamp(hw.min + Math.round((hardware - hw.min) / hw.step) * hw.step, hw.min, hw.max);
  const digital = total / hardware;
  // Ignore a hairline of digital zoom left over from rounding to the camera's zoom step.
  return { hardware, digital: digital < 1.02 ? 1 : clamp(digital, 1, DIGITAL_ZOOM_MAX) };
}

/**
 * The square of the video frame (in video pixels) to decode: what is inside the viewfinder, plus a
 * small margin, at the current digital zoom. The video is shown with object-fit: cover.
 */
export function decodeRegion(
  video: { width: number; height: number },
  view: { width: number; height: number },
  digital: number,
): { x: number; y: number; size: number } {
  let size: number;
  if (view.width > 0 && view.height > 0) {
    const cssPerVideoPx = Math.max(view.width / video.width, view.height / video.height) * digital;
    const frame = Math.min(view.height * FRAME_FRACTION, view.width) * 1.1;
    size = frame / cssPerVideoPx;
  } else {
    size = Math.min(video.width, video.height) / digital;
  }
  size = Math.min(size, video.width, video.height);
  return { x: (video.width - size) / 2, y: (video.height - size) / 2, size };
}

export class CameraScanner {
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private timer = 0;
  private running = false;
  private readonly canvas = document.createElement('canvas');
  private hw: HardwareZoom | null = null;
  private total = 1;
  private digital = 1;
  private hwBusy = false;
  private hwPending: number | null = null;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onCode: (text: string) => void,
  ) {}

  get deviceId(): string | undefined {
    return this.track?.getSettings().deviceId;
  }

  /** Current total zoom (camera × digital). */
  get zoom(): number {
    return this.total;
  }

  get zoomRange(): { min: number; max: number } {
    return zoomRange(this.hw);
  }

  /** Whether the camera's own zoom is available (otherwise zoom is digital only). */
  get hasCameraZoom(): boolean {
    return !!this.hw;
  }

  /** Set the total zoom; returns the value actually applied. */
  setZoom(total: number): number {
    const r = this.zoomRange;
    this.total = clamp(total, r.min, r.max);
    const { hardware, digital } = splitZoom(this.total, this.hw);
    this.digital = digital;
    this.video.style.transform = digital > 1.001 ? `scale(${digital.toFixed(3)})` : '';
    if (hardware !== null) void this.applyHardwareZoom(hardware);
    return this.total;
  }

  private async applyHardwareZoom(zoom: number): Promise<void> {
    // Coalesce rapid changes (pinching): only the latest value is applied next.
    if (this.hwBusy) {
      this.hwPending = zoom;
      return;
    }
    const track = this.track;
    if (!track) return;
    this.hwBusy = true;
    try {
      await track.applyConstraints({ advanced: [{ zoom } as MediaTrackConstraintSet] });
    } catch {
      /* the camera refused: digital zoom still works */
    } finally {
      this.hwBusy = false;
      const next = this.hwPending;
      this.hwPending = null;
      if (next !== null && next !== zoom) void this.applyHardwareZoom(next);
    }
  }

  async start(deviceId?: string): Promise<void> {
    this.stop();
    const video: MediaTrackConstraints & { zoom?: boolean } = {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
      // Higher resolution leaves detail for digital zoom; `zoom: true` asks for camera zoom control.
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      zoom: true,
    };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    this.stream = stream;
    this.track = stream.getVideoTracks()[0] ?? null;
    const caps = (this.track?.getCapabilities?.() ?? {}) as { zoom?: Partial<HardwareZoom> };
    const z = caps.zoom;
    this.hw =
      z && typeof z.min === 'number' && typeof z.max === 'number' && z.max > z.min
        ? { min: z.min, max: z.max, step: z.step ?? 0.1 }
        : null;
    this.running = true;
    this.video.srcObject = stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play().catch(() => {});
    this.setZoom(this.total); // re-apply (and re-clamp) the zoom for this camera
    const decode = await getDecoder();
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    const tick = async () => {
      if (!this.running) return;
      const v = this.video;
      if (v.videoWidth && v.readyState >= 2) {
        const r = decodeRegion(
          { width: v.videoWidth, height: v.videoHeight },
          { width: v.clientWidth, height: v.clientHeight },
          this.digital,
        );
        // Downscale big crops for speed; upscale small (zoomed) crops so modules span several pixels.
        const out = Math.round(clamp(r.size, 480, 960));
        this.canvas.width = this.canvas.height = out;
        ctx.imageSmoothingEnabled = out <= r.size;
        ctx.drawImage(v, r.x, r.y, r.size, r.size, 0, 0, out, out);
        try {
          const text = await decode(this.canvas);
          if (text && this.running) {
            this.stop();
            this.onCode(text);
            return;
          }
        } catch {
          /* transient decode failure: keep scanning */
        }
      }
      if (this.running) this.timer = window.setTimeout(tick, 120);
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    this.video.srcObject = null;
  }
}

/** Find a QR code in an image file. Transparent images are tried over white and over black. */
export async function decodeImage(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  const decode = await getDecoder();
  const jsqr = await jsqrDecoder();
  const canvas = document.createElement('canvas');
  try {
    for (const max of [1600, 800, 2400]) {
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      for (const bg of ['#ffffff', '#000000']) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const text = (await decode(canvas)) ?? (await jsqr(canvas));
        if (text) return text;
      }
      if (scale === 1 && max >= 1600) break;
    }
  } finally {
    bitmap.close();
  }
  return null;
}
