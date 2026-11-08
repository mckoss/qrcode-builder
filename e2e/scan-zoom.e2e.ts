import { expect, test } from '@playwright/test';
import { failOnPageErrors, fakeCameraScene, freshApp, setScanZoom, showScene, type SceneCode } from './helpers';

// Layout of the 640×480 fake camera frame. At 1× the decoded square (viewfinder plus margin) spans
// roughly x 130–510, y 50–430; at 3× it narrows to roughly x 257–383, y 177–303.
const CENTER: SceneCode = { text: 'https://example.com/center', x: 265, y: 185, size: 110 };
const IN_FRAME_CORNER: SceneCode = { text: 'https://example.com/corner', x: 395, y: 65, size: 100 };
const OUTSIDE_FRAME: SceneCode = { text: 'https://example.com/outside', x: 10, y: 10, size: 100 };

test.describe('scanner zoom', () => {
  test('zooming in isolates the code in the middle when several are in the viewfinder', async ({ page }) => {
    const noErrors = failOnPageErrors(page);
    await fakeCameraScene(page, [CENTER, IN_FRAME_CORNER]);
    await freshApp(page);
    await page.click('#scan-open');
    await expect(page.locator('#scan-zoom-row')).toBeVisible();
    await expect(page.locator('#scan-status')).toHaveText('Point your camera at a QR code.');

    await setScanZoom(page, 3);
    await expect(page.locator('#scan-zoom-badge')).toHaveText('3.0×');
    // No camera zoom on this device, so all 3× is digital: the preview is magnified.
    await expect(page.locator('#scan-video')).toHaveAttribute('style', /scale\(3(\.0*)?\)/);

    await showScene(page);
    await expect(page.locator('#scan-result')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#scan-preview')).toHaveText('https://example.com/center');
    noErrors();
  });

  test('only codes inside the viewfinder square are read', async ({ page }) => {
    await fakeCameraScene(page, [OUTSIDE_FRAME, IN_FRAME_CORNER]);
    await freshApp(page);
    await page.click('#scan-open');
    await expect(page.locator('#scan-status')).toHaveText('Point your camera at a QR code.');
    await showScene(page);
    // The code outside the square is ignored; the one inside it (though off-center) is read.
    await expect(page.locator('#scan-result')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#scan-preview')).toHaveText('https://example.com/corner');
  });

  test('pinch, buttons and wheel change the zoom within its range', async ({ page }) => {
    await fakeCameraScene(page, [CENTER]);
    await freshApp(page);
    await page.click('#scan-open');
    await expect(page.locator('#scan-zoom-row')).toBeVisible();
    const badge = page.locator('#scan-zoom-badge');
    await expect(badge).toHaveText('1.0×');

    // Pinch: two touch points spread from 100 px apart to 200 px apart doubles the zoom.
    const view = page.locator('#scan-view');
    const box = (await view.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const touch = { pointerType: 'touch', bubbles: true };
    await view.dispatchEvent('pointerdown', { ...touch, pointerId: 1, clientX: cx - 50, clientY: cy, isPrimary: true });
    await view.dispatchEvent('pointerdown', { ...touch, pointerId: 2, clientX: cx + 50, clientY: cy });
    await view.dispatchEvent('pointermove', { ...touch, pointerId: 2, clientX: cx + 150, clientY: cy });
    await view.dispatchEvent('pointerup', { ...touch, pointerId: 2, clientX: cx + 150, clientY: cy });
    await view.dispatchEvent('pointerup', { ...touch, pointerId: 1, clientX: cx - 50, clientY: cy });
    await expect(badge).toHaveText('2.0×');

    await page.click('#scan-zoom-in');
    await expect(badge).toHaveText('2.5×');
    await page.click('#scan-zoom-out');
    await page.click('#scan-zoom-out');
    await expect(badge).toHaveText('1.6×');

    // Wheel zooms too, and the range is clamped (digital-only max is 4×, min 1×).
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -400);
    await expect(badge).toHaveText('4.0×');
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 400);
    await expect(badge).toHaveText('1.0×');
  });

  test('uses the camera’s own zoom first, then digital zoom beyond its maximum', async ({ page }) => {
    await fakeCameraScene(page, [CENTER], { cameraZoom: { min: 1, max: 5, step: 0.1 } });
    await freshApp(page);
    await page.click('#scan-open');
    await expect(page.locator('#scan-zoom-row')).toBeVisible();
    const applied = () => page.evaluate(() => (window as unknown as { __zoomApplied: number[] }).__zoomApplied.at(-1));
    const video = page.locator('#scan-video');

    await setScanZoom(page, 3);
    await expect.poll(applied).toBeCloseTo(3, 5);
    await expect(video).not.toHaveAttribute('style', /scale/);

    await setScanZoom(page, 8);
    await expect.poll(applied).toBeCloseTo(5, 5);
    await expect(video).toHaveAttribute('style', /scale\(1\.60*\)/);
    await expect(page.locator('#scan-zoom-badge')).toHaveText('8.0×');

    // The slider tops out at the camera's maximum times the digital maximum (5 × 4).
    expect(Number(await page.locator('#scan-zoom').getAttribute('max'))).toBeCloseTo(Math.log(20), 5);
  });
});
