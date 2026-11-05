import { expect, test } from '@playwright/test';
import {
  acceptDialogs,
  choose,
  decodePng,
  download,
  failOnPageErrors,
  fakeCamera,
  freshApp,
  qrPng,
  storedLibrary,
} from './helpers';

test.describe('clone by scanning, then revise', () => {
  test('camera scan adds an editable code; edits and exports revise that same code', async ({ page }, testInfo) => {
    acceptDialogs(page);
    const noErrors = failOnPageErrors(page);
    // A code as another app writes it: different field order and "WPA2".
    await fakeCamera(page, 'WIFI:S:Office;T:WPA2;P:hunter22;;');
    await freshApp(page);

    await page.click('#scan-open');
    await expect(page.locator('#scan-result')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#scan-type')).toHaveText('Wi-Fi');
    await expect(page.locator('#scan-preview')).toHaveText('Network: Office\nPassword: hunter22');
    await expect(page.locator('#scan-dropped')).toBeHidden();
    await page.click('#scan-accept');

    const state = page.locator('#edit-state');
    const count = page.locator('#history-count');
    await expect(page.locator('#edit-kicker')).toHaveText(/Scanned code/);
    await expect(page.locator('#f-wifi-ssid')).toHaveValue('Office');
    await expect(page.locator('#f-wifi-password')).toHaveValue('hunter22');
    await expect(page.locator('#save-history')).toHaveText('Saved');
    await expect(count).toHaveText('1');

    // Revise and save.
    await page.fill('#f-wifi-password', 'hunter33');
    await page.fill('#description', 'Office Wi-Fi');
    await expect(state).toHaveText('Unsaved changes');
    await page.click('#save-history');
    await expect(state).toHaveText(/^Saved/);

    // Exporting a further revision updates the same code rather than adding one.
    await choose(page, 'ec', 'H');
    await expect(page.locator('#meta')).toContainText('EC H');
    const png = await download(page, '#dl-png', testInfo);
    expect(decodePng(png.path).text).toBe('WIFI:T:WPA;S:Office;P:hunter33;;');
    await expect(count).toHaveText('1');
    await expect(state).toHaveText(/^Saved/);

    // Stored as source data only.
    const lib = await storedLibrary(page);
    expect(lib).toHaveLength(1);
    expect(lib[0]).toMatchObject({ source: 'scan', description: 'Office Wi-Fi', style: { ec: 'H' } });
    expect(lib[0]).not.toHaveProperty('payload');

    // The editing session survives a reload.
    await page.reload();
    await expect(page.locator('#edit-banner')).toBeVisible();
    await expect(page.locator('#edit-title')).toHaveText('Office Wi-Fi');
    await expect(state).toHaveText(/^Saved/);

    // Save as copy branches; New code detaches.
    await page.fill('#f-wifi-ssid', 'Office-5G');
    await page.click('#edit-copy');
    await expect(count).toHaveText('2');
    await page.click('#edit-new');
    await expect(page.locator('#edit-banner')).toBeHidden();
    await expect(page.locator('#f-wifi-ssid')).toHaveValue('');
    noErrors();
  });

  test('switching type while editing starts a new code instead of overwriting', async ({ page }) => {
    acceptDialogs(page);
    await freshApp(page);
    await page.fill('#f-wifi-ssid', 'Home');
    await page.fill('#f-wifi-password', 'secret123');
    await page.click('#save-history');
    await expect(page.locator('#edit-banner')).toBeVisible();

    await page.click('#type-picker button:text-is("URL")');
    await expect(page.locator('#edit-banner')).toBeHidden();
    await page.fill('#f-url-url', 'https://example.com');
    await page.click('#save-history');
    await expect(page.locator('#history-count')).toHaveText('2');
    const types = (await storedLibrary(page)).map((e) => e.type).sort();
    expect(types).toEqual(['url', 'wifi']);
  });

  test('scan from image files: this app’s transparent export, and a contact card from another app', async ({ page }, testInfo) => {
    acceptDialogs(page);
    await freshApp(page);
    await page.fill('#f-wifi-ssid', 'Office');
    await page.fill('#f-wifi-password', 'hunter22');
    await expect(page.locator('#payload')).toHaveText('WIFI:T:WPA;S:Office;P:hunter22;;');
    const exported = await download(page, '#dl-png', testInfo);

    await page.click('#scan-open');
    await page.setInputFiles('#scan-file', exported.path);
    await expect(page.locator('#scan-result')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#scan-type')).toHaveText('Wi-Fi');
    await expect(page.locator('#scan-preview')).toHaveText('Network: Office\nPassword: hunter22');

    const vcard = [
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N:Doe;Jane;Q;;',
      'TEL;CELL:+1 555 0100',
      'TEL;WORK:+1 555 0199',
      'EMAIL:jane@example.com',
      'BDAY:1990-01-01',
      'END:VCARD',
    ].join('\r\n');
    await page.click('#scan-again');
    await page.setInputFiles('#scan-file', await qrPng(testInfo, 'vcard.png', vcard));
    await expect(page.locator('#scan-type')).toHaveText('Contact', { timeout: 15_000 });
    await expect(page.locator('#scan-dropped')).toContainText('additional phone');
    await expect(page.locator('#scan-dropped')).toContainText('bday');

    // Keep the original exactly instead.
    await page.click('#scan-as-text');
    await expect(page.locator('#scan-dialog')).toBeHidden();
    await expect(page.locator('#payload')).toHaveText(vcard);
    await expect(page.locator('#edit-kicker')).toHaveText(/Scanned code/);
  });
});
