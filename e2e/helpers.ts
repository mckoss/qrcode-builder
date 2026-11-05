import { readFileSync } from 'node:fs';
import { expect, type Download, type Page, type TestInfo } from '@playwright/test';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import QRCode from 'qrcode';

/** Open the app with empty storage. */
export async function freshApp(page: Page): Promise<void> {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('#app-version')).toHaveText(/^v\d+\.\d+\.\d+$/);
}

/** Accept confirm() dialogs (e.g. "Discard unsaved changes?"). */
export function acceptDialogs(page: Page): void {
  page.on('dialog', (d) => d.accept());
}

/** Fail the test on uncaught page errors and console errors. */
export function failOnPageErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return () => expect(errors, 'page errors').toEqual([]);
}

/** Click a control and save the resulting download into the test's output folder. */
export async function download(page: Page, selector: string, testInfo: TestInfo): Promise<{ path: string; name: string }> {
  const [d]: [Download, void] = await Promise.all([page.waitForEvent('download'), page.click(selector)]);
  const name = d.suggestedFilename();
  const path = testInfo.outputPath(name);
  await d.saveAs(path);
  return { path, name };
}

/** Click a visually hidden radio's label (segmented controls). */
export async function choose(page: Page, name: string, value: string): Promise<void> {
  await page.click(`label:has(input[name="${name}"][value="${value}"]) span`);
}

export interface DecodedPng {
  text: string | null;
  width: number;
  height: number;
  /** RGBA of the top-left pixel. */
  corner: number[];
  /** RGB of the first fully opaque pixel, if any. */
  firstOpaque: number[] | null;
}

/** Decode a QR code from a PNG, compositing transparency over `bg` first. */
export function decodePng(path: string, bg: [number, number, number] = [255, 255, 255]): DecodedPng {
  const png = PNG.sync.read(readFileSync(path));
  const { width, height, data } = png;
  const flat = new Uint8ClampedArray(data.length);
  let firstOpaque: number[] | null = null;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    if (!firstOpaque && data[i + 3] === 255) firstOpaque = [data[i], data[i + 1], data[i + 2]];
    for (let k = 0; k < 3; k++) flat[i + k] = Math.round(data[i + k] * a + bg[k] * (1 - a));
    flat[i + 3] = 255;
  }
  const r = jsQR(flat, width, height);
  return { text: r ? r.data : null, width, height, corner: [...data.subarray(0, 4)], firstOpaque };
}

/** Write a QR code PNG (as some other generator would make it) for scan tests. */
export async function qrPng(testInfo: TestInfo, name: string, text: string): Promise<string> {
  const path = testInfo.outputPath(name);
  await QRCode.toFile(path, text, { width: 400, margin: 4 });
  return path;
}

/**
 * Replace the camera with a canvas stream showing `text` as a QR code on a busy background,
 * so camera scanning can be tested headlessly.
 */
export async function fakeCamera(page: Page, text: string): Promise<void> {
  const dataUrl = await QRCode.toDataURL(text, { width: 300, margin: 4 });
  await page.addInitScript((src: string) => {
    navigator.mediaDevices.getUserMedia = async () => {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 480;
      const g = c.getContext('2d')!;
      const img = new Image();
      img.src = src;
      await img.decode();
      const draw = () => {
        g.fillStyle = '#887766';
        g.fillRect(0, 0, 640, 480);
        g.drawImage(img, 170, 90, 300, 300);
      };
      draw();
      setInterval(draw, 60);
      return c.captureStream(15);
    };
    navigator.mediaDevices.enumerateDevices = async () =>
      [{ kind: 'videoinput', deviceId: 'fake', label: 'Fake camera', groupId: '' } as MediaDeviceInfo];
  }, dataUrl);
}

/** Library entries currently stored, as the app reads them. */
export async function storedLibrary(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('qrb.library.v2') ?? '[]'));
}
