import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { choose, decodePng, download, failOnPageErrors, freshApp } from './helpers';

// Calendar events are encoded in UTC; pin the browser's zone so expectations are stable.
test.use({ timezoneId: 'UTC' });

const WIFI = 'WIFI:T:WPA;S:My\\;Net;P:p@ss\\:word;;';

test.describe('create and export', () => {
  test('Wi-Fi PNG decodes to the exact payload, with a transparent background and text blocks', async ({ page }, testInfo) => {
    const noErrors = failOnPageErrors(page);
    await freshApp(page);
    await page.fill('#f-wifi-ssid', 'My;Net');
    await page.fill('#f-wifi-password', 'p@ss:word');
    await page.fill('#description', 'Guest Wi-Fi');
    await page.check('#show-decoded');
    await expect(page.locator('#payload')).toHaveText(WIFI);
    await expect(page.locator('#preview')).toHaveAttribute('aria-label', 'QR code: Guest Wi-Fi');

    const png = await download(page, '#dl-png', testInfo);
    expect(png.name).toBe('qr-guest-wi-fi.png');
    const d = decodePng(png.path);
    expect(d.text).toBe(WIFI);
    expect(d.width).toBe(1024);
    expect(d.height).toBeGreaterThan(1024); // description above + decoded text below
    expect(d.corner[3]).toBe(0); // transparent by default
    noErrors();
  });

  test('custom code color, error correction and solid background', async ({ page }, testInfo) => {
    await freshApp(page);
    await page.fill('#f-wifi-ssid', 'Office');
    await page.fill('#f-wifi-password', 'hunter22');
    await page.fill('#fg-hex', '#1d4ed8');
    await choose(page, 'ec', 'H');
    await expect(page.locator('#meta')).toContainText('EC H');

    let d = decodePng((await download(page, '#dl-png', testInfo)).path);
    expect(d.text).toBe('WIFI:T:WPA;S:Office;P:hunter22;;');
    expect(d.width).toBe(1024);
    expect(d.height).toBe(1024); // no text blocks
    expect(d.firstOpaque).toEqual([29, 78, 216]);
    expect(d.corner[3]).toBe(0);

    await choose(page, 'bg-mode', 'solid');
    await page.fill('#bg-hex', '#fff3c4');
    await expect(page.locator('#preview-stage')).not.toHaveClass(/checker/);
    d = decodePng((await download(page, '#dl-png', testInfo)).path, [0, 0, 0]);
    expect(d.corner).toEqual([255, 243, 196, 255]);
    expect(d.text).toBe('WIFI:T:WPA;S:Office;P:hunter22;;');

    const svg = readFileSync((await download(page, '#dl-svg', testInfo)).path, 'utf8');
    expect(svg).toContain('<rect width="100%" height="100%" fill="#fff3c4"/>');
    expect(svg).toContain('fill="#1d4ed8"');
  });

  test('PDF page is cropped to the content, at the chosen physical size', async ({ page }, testInfo) => {
    await freshApp(page);
    await page.fill('#f-wifi-ssid', 'Office');
    await page.fill('#f-wifi-password', 'hunter22');
    await page.check('#show-decoded');
    await page.fill('#description', 'Guest Wi-Fi');
    await expect(page.locator('#preview')).toHaveAttribute('aria-label', 'QR code: Guest Wi-Fi');

    const latin = readFileSync((await download(page, '#dl-pdf', testInfo)).path).toString('latin1');
    expect(latin.startsWith('%PDF-')).toBe(true);
    const [, w, h] = /MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(latin)!;
    expect(Number(w)).toBeCloseTo(216, 0); // 3 in × 72 pt
    expect(Number(h)).toBeGreaterThan(216);
    expect(latin).toContain('Helvetica-Bold');
    expect(latin).toContain('Courier');

    // Non-Latin text still exports (drawn as an image).
    await page.fill('#description', 'ゲスト Wi-Fi ☕');
    await expect(page.locator('#preview')).toHaveAttribute('aria-label', 'QR code: ゲスト Wi-Fi ☕');
    const uni = readFileSync((await download(page, '#dl-pdf', testInfo)).path).toString('latin1');
    expect(uni.startsWith('%PDF-')).toBe(true);
    expect(uni).toContain('/Subtype /Image');
  });

  test('each content type encodes as expected', async ({ page }) => {
    await freshApp(page);
    const payload = page.locator('#payload');
    const pick = (label: string) => page.click(`#type-picker button:text-is("${label}")`);

    await pick('URL');
    await page.fill('#f-url-url', 'example.com/a');
    await expect(payload).toHaveText('https://example.com/a');

    await pick('Email');
    await page.fill('#f-email-to', 'a@b.com');
    await page.fill('#f-email-subject', 'Hi there');
    await expect(payload).toHaveText('mailto:a@b.com?subject=Hi%20there');

    await pick('SMS');
    await page.fill('#f-sms-number', '+1 555 0100');
    await page.fill('#f-sms-message', 'Hello');
    await expect(payload).toHaveText('SMSTO:+15550100:Hello');

    await pick('Contact');
    await page.fill('#f-vcard-first', 'Ada');
    await page.fill('#f-vcard-last', 'Lovelace');
    await page.fill('#f-vcard-email', 'ada@example.com');
    await expect(payload).toHaveText(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Lovelace;Ada;;;\r\nFN:Ada Lovelace\r\nEMAIL:ada@example.com\r\nEND:VCARD',
    );

    await pick('Event');
    await page.fill('#f-event-title', 'Party');
    await page.fill('#f-event-start', '2026-12-01T18:00');
    await expect(payload).toHaveText('BEGIN:VEVENT\r\nSUMMARY:Party\r\nDTSTART:20261201T180000Z\r\nEND:VEVENT');

    await pick('Location');
    await page.fill('#f-geo-lat', '47.6205');
    await page.fill('#f-geo-lng', '-122.3493');
    await expect(payload).toHaveText('geo:47.6205,-122.3493');
  });

  test('incomplete content explains what is missing and disables export', async ({ page }) => {
    await freshApp(page);
    await expect(page.locator('#preview-empty')).toHaveText('Enter the network name (SSID).');
    await expect(page.locator('#dl-png')).toBeDisabled();
    await page.fill('#f-wifi-ssid', 'Office');
    await expect(page.locator('#preview-empty')).toContainText('password');
    await page.selectOption('#f-wifi-security', 'nopass');
    await expect(page.locator('#dl-png')).toBeEnabled();
    await expect(page.locator('#payload')).toHaveText('WIFI:T:nopass;S:Office;;');
  });
});

test.describe('phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('fits the screen without horizontal scrolling and shows the version', async ({ page }) => {
    await freshApp(page);
    await page.fill('#f-wifi-ssid', 'Cafe');
    await page.fill('#f-wifi-password', 'latte123');
    await expect(page.locator('#payload')).toHaveText('WIFI:T:WPA;S:Cafe;P:latte123;;');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);
    await expect(page.locator('#app-version')).toBeVisible();
  });
});
