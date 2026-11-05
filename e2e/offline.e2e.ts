import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { download, failOnPageErrors, qrPng } from './helpers';

// These tests need the real service worker.
test.use({ serviceWorkers: 'allow' });

test('installable PWA that works fully offline', async ({ page, context }, testInfo) => {
  const noErrors = failOnPageErrors(page);
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  // Chrome's own installability check.
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  expect(installabilityErrors).toEqual([]);
  const manifest = await cdp.send('Page.getAppManifest');
  expect(manifest.errors).toEqual([]);
  await cdp.detach();

  // Make and save a code while online.
  await page.fill('#f-wifi-ssid', 'Cabin');
  await page.fill('#f-wifi-password', 'offgrid1');
  await expect(page.locator('#payload')).toHaveText('WIFI:T:WPA;S:Cabin;P:offgrid1;;');
  await page.click('#save-history');
  await expect(page.locator('#history-count')).toHaveText('1');
  const scanImage = await qrPng(testInfo, 'offline.png', 'https://example.com/offline');

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.locator('#offline-status')).toContainText('Offline');
    await expect(page.locator('#payload')).toHaveText('WIFI:T:WPA;S:Cabin;P:offgrid1;;');

    // Lazy-loaded features come from the offline cache: PDF export (jsPDF) and image scanning (jsQR).
    const pdf = readFileSync((await download(page, '#dl-pdf', testInfo)).path).toString('latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);

    await page.click('#scan-open');
    await page.setInputFiles('#scan-file', scanImage);
    await expect(page.locator('#scan-type')).toHaveText('URL', { timeout: 15_000 });
    await page.click('#scan-close');

    // The library is drawn from stored source data.
    await page.click('#tab-history');
    await expect(page.locator('.history-item')).toHaveCount(1);
    await expect
      .poll(() => page.evaluate(() => (document.querySelector('.history-item canvas') as HTMLCanvasElement).width))
      .toBeGreaterThan(1);
  } finally {
    await context.setOffline(false);
  }
  noErrors();
});
