// Generates public/favicon.svg and the PNG app icons. Requires Playwright (Chromium) to rasterize.
// Usage: npm run icons
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// CommonJS require so a globally installed Playwright is found too.
const { chromium } = createRequire(import.meta.url)('playwright');

const BLUE = '#1d4ed8';
const finders = [
  [0, 0],
  [8, 0],
  [0, 8],
];
const data = [
  [8, 8], [10, 8], [13, 8], [11, 9], [14, 9], [9, 10], [12, 10], [14, 10],
  [8, 11], [10, 11], [11, 12], [13, 12], [8, 13], [12, 13], [14, 13], [9, 14], [10, 14], [13, 14],
];

function svg({ rounded }) {
  const f = finders
    .map(([x, y]) => `M${x} ${y}h7v7h-7zM${x + 1} ${y + 1}v5h5v-5zM${x + 2} ${y + 2}h3v3h-3z`)
    .join('');
  const d = data.map(([x, y]) => `M${x} ${y}h1v1h-1z`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" ${rounded ? 'rx="14"' : ''} fill="${BLUE}"/>
<g transform="translate(14 14) scale(2.4)" fill="#fff" fill-rule="evenodd" shape-rendering="crispEdges"><path d="${f}"/><path d="${d}"/></g>
</svg>
`;
}

writeFileSync('public/favicon.svg', svg({ rounded: true }));

const targets = [
  ['public/icons/pwa-192.png', 192, true],
  ['public/icons/pwa-512.png', 512, true],
  ['public/icons/maskable-512.png', 512, false],
  ['public/icons/apple-touch-icon.png', 180, false],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, size, rounded] of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">` +
      svg({ rounded }).replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `) +
      `</body></html>`,
  );
  await page.screenshot({ path: file, omitBackground: true });
  console.log('wrote', file);
}
await browser.close();
