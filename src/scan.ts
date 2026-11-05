// QR reading from the camera or an image. Uses the native BarcodeDetector when it supports QR codes,
// otherwise jsQR (lazy-loaded, cached for offline use by the service worker).

type Decode = (canvas: HTMLCanvasElement) => Promise<string | null>;

interface NativeDetector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
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
            if (r.length) return r[0].rawValue;
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

export class CameraScanner {
  private stream: MediaStream | null = null;
  private timer = 0;
  private running = false;
  private readonly canvas = document.createElement('canvas');

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onCode: (text: string) => void,
  ) {}

  get deviceId(): string | undefined {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId;
  }

  async start(deviceId?: string): Promise<void> {
    this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    this.stream = stream;
    this.running = true;
    this.video.srcObject = stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play().catch(() => {});
    const decode = await getDecoder();
    const tick = async () => {
      if (!this.running) return;
      const v = this.video;
      if (v.videoWidth && v.readyState >= 2) {
        const scale = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight));
        this.canvas.width = Math.round(v.videoWidth * scale);
        this.canvas.height = Math.round(v.videoHeight * scale);
        this.canvas.getContext('2d', { willReadFrequently: true })!.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
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
