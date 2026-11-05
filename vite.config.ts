import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves project sites from /<repo>/; the deploy workflow sets BASE_PATH.
const base = process.env.BASE_PATH || '/';

// Single source of truth for the app version (semver): package.json.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  resolve: {
    alias: Object.fromEntries(
      ['html2canvas', 'dompurify', 'canvg'].map((m) => [m, fileURLToPath(new URL('./src/stubs/unused.ts', import.meta.url))]),
    ),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 450,
  },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeManifestIcons: false, // already matched by globPatterns
      manifest: {
        name: 'QR Code Builder',
        short_name: 'QR Builder',
        description:
          'Build QR codes for Wi-Fi, links, contacts and more. Transparent backgrounds, custom colors, PNG/PDF/SVG export. Works offline; nothing leaves your device.',
        theme_color: '#1d4ed8',
        background_color: '#f6f7f9',
        display: 'standalone',
        orientation: 'any',
        categories: ['utilities', 'productivity'],
        icons: [
          { src: 'icons/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
});
