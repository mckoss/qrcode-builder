import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { acceptDialogs, download, freshApp, storedLibrary } from './helpers';

async function saveTextCodes(page: Page, texts: string[]): Promise<void> {
  await page.click('#type-picker button:text-is("Text")');
  for (const t of texts) {
    if (await page.locator('#edit-new').isVisible()) await page.click('#edit-new');
    await page.fill('#f-text-text', t);
    await expect(page.locator('#payload')).toHaveText(t);
    await page.click('#save-history');
    await expect(page.locator('#edit-title')).toHaveText(t);
  }
}

test.describe('library', () => {
  test('export, clear, import and re-import without duplicates; a newer revision wins', async ({ page }, testInfo) => {
    acceptDialogs(page);
    await freshApp(page);
    await saveTextCodes(page, ['alpha', 'beta', 'gamma']);
    await page.click('#tab-history');
    const cards = page.locator('.history-item');
    await expect(cards).toHaveCount(3);

    const file = await download(page, '#history-export', testInfo);
    expect(file.name).toMatch(/^qr-library-\d{4}-\d{2}-\d{2}\.json$/);
    const exported = JSON.parse(readFileSync(file.path, 'utf8'));
    expect(exported).toMatchObject({ app: 'qrcode-builder', version: 2 });
    expect(exported.entries).toHaveLength(3);
    expect(JSON.stringify(exported)).not.toContain('payload');

    await page.click('#history-clear');
    await page.click('#clear-dialog button[value="all"]');
    await expect(cards).toHaveCount(0);

    const toast = page.locator('#toast');
    await page.setInputFiles('#history-file', file.path);
    await expect(toast).toHaveText('Import complete: 3 new codes added.');
    await expect(cards).toHaveCount(3);

    await page.setInputFiles('#history-file', file.path);
    await expect(toast).toHaveText('Nothing new to import (3 duplicates skipped).');
    await expect(cards).toHaveCount(3);

    // The same code edited elsewhere (newer), plus a copy of another under a different id.
    const alpha = exported.entries.find((e: { fields?: { text?: string } }) => e.fields?.text === 'alpha');
    alpha.fields.text = 'alpha v2';
    alpha.updated = Date.now() + 60_000;
    exported.entries.push({ ...exported.entries[0], id: 'from-another-device' });
    const edited = testInfo.outputPath('edited.json');
    writeFileSync(edited, JSON.stringify(exported));
    await page.setInputFiles('#history-file', edited);
    await expect(toast).toHaveText('Import complete: 1 code updated to a newer version, 3 duplicates skipped.');
    await expect(cards).toHaveCount(3);
    await expect(page.locator('.history-title')).toContainText(['alpha v2']);
  });

  test('search, pin, delete with undo, and edit from the library', async ({ page }) => {
    acceptDialogs(page);
    await freshApp(page);
    await saveTextCodes(page, ['red apple', 'green pear', 'red cherry']);
    await page.click('#tab-history');
    const cards = page.locator('.history-item');

    await page.fill('#history-search', 'red');
    await expect(cards).toHaveCount(2);
    await page.fill('#history-search', '');
    await expect(cards).toHaveCount(3);

    // Pinned codes sort first.
    await cards.filter({ hasText: 'green pear' }).getByRole('button', { name: 'Pin', exact: true }).click();
    await expect(cards.first()).toContainText('green pear');

    await cards.filter({ hasText: 'red apple' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(cards).toHaveCount(2);
    await page.locator('#toast button', { hasText: 'Undo' }).click();
    await expect(cards).toHaveCount(3);

    await cards.filter({ hasText: 'red cherry' }).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.locator('#view-create')).toBeVisible();
    await expect(page.locator('#edit-title')).toHaveText('red cherry');
    await expect(page.locator('#f-text-text')).toHaveValue('red cherry');
  });

  test('a library saved by v1.0–1.1 is migrated to the compact format', async ({ page }) => {
    await page.goto('./');
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem(
        'qrb.history.v1',
        JSON.stringify([
          {
            id: 'legacy-1',
            created: 1,
            updated: 2,
            type: 'wifi',
            fields: { ssid: 'Old Net', security: 'WPA', password: 'pw123456', hidden: false },
            style: { fg: '#000000', bg: '#ffffff', transparent: true, ec: 'M', margin: 4 },
            description: 'Legacy',
            showDescription: true,
            showDecoded: false,
            payload: 'WIFI:T:WPA;S:Old Net;P:pw123456;;',
            pinned: true,
          },
        ]),
      );
    });
    await page.reload();
    await page.click('#tab-history');
    await expect(page.locator('.history-item')).toHaveCount(1);
    await expect(page.locator('.history-title')).toHaveText('📌 Legacy');
    expect(await page.evaluate(() => localStorage.getItem('qrb.history.v1'))).toBeNull();
    const lib = await storedLibrary(page);
    expect(lib[0]).toMatchObject({ id: 'legacy-1', pinned: true });
    expect(lib[0]).not.toHaveProperty('payload');
  });
});
