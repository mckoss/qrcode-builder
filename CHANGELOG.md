# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/). The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [1.3.0] - 2026-11-08

### Added
- Zoom while scanning: pinch on the camera view, or use the slider, +/− buttons or mouse wheel.
  - The camera's own zoom is used first where the browser exposes it (optical on many phones). Digital zoom adds up to 4× beyond that, or provides all of the zoom where camera zoom isn't available.
  - A readout on the camera view shows the current zoom.

### Changed
- Scanning reads only the code inside the viewfinder square, and picks the one nearest the center if several are visible, so zooming in isolates a single code among many. The camera now requests up to 1080p so digital zoom has detail to work with.

## [1.2.4] - 2026-11-08

### Changed
- Privacy wording now matches what the app does: QR content, library and scans never leave the device, and the only data sent is an anonymous, cookieless page-view count. Replaces "no tracking" and "nothing leaves your device" in the footer, description, web app manifest and README.

## [1.2.3] - 2026-11-08

### Added
- Page-view analytics via the shared mckoss.com Umami loader (`https://mckoss.com/js/mk.js`). The service worker doesn't cache it, and the app works offline without it.

## [1.2.2] - 2026-11-06

### Added
- An "About" link in the footer that opens the blog post about the app ([Vibe Coding a QR Code Builder With No Strings Attached](https://mckoss.com/posts/vibe-coding-qr-code-builder/)).

## [1.2.1] - 2026-11-05

### Fixed
- The Library tab's count now updates right after a scanned code is added.

### Added
- An end-to-end browser test suite (Playwright) that runs in CI on every push and pull request. Deploys wait for it to pass.

## [1.2.0] - 2026-11-05

### Changed
- The library stores only each code's source data (type, non-empty fields, style and text options). The encoded payload is no longer stored; it's regenerated on load, and codes are always redrawn on demand. A typical code takes a few hundred bytes.
- The 200-code limit is removed, and codes are never pruned automatically. If browser storage is full, the save fails with a message instead of deleting older codes.
- Library thumbnails are drawn as they scroll into view.
- Library exports use the compact format (version 2). Older exports still import.
- Importing a library never adds duplicates: codes already present, or repeated within the file, are skipped. A newer revision of a code you already have replaces the older one. The result message reports how many codes were added, updated, skipped or unreadable.

### Migration
- Libraries saved by 1.0–1.1 are converted to the compact format on first load, and the old copy is removed.

## [1.1.0] - 2026-11-05

### Added
- Clone an existing QR code by scanning it with the camera, or from an image file or a pasted image. The code is recognized (Wi-Fi, URL, email, phone, SMS, vCard/MECARD contact, location, calendar event, or text) and added to the library as an editable code.
- A warning before adding a scanned code that has details the editor can't represent, with an option to keep the exact original text.
- Every library code can be revised in place. The editor shows which code is open and whether it has unsaved changes, and offers "Save as copy" and "New code".
- The app version is shown in the header.

### Changed
- "History" is renamed "Library".
- Switching the code type while editing a library code starts a new code instead of overwriting the open one.

### Fixed
- The latest edits are no longer lost when the app is closed or reloaded right after typing.

## [1.0.0] - 2026-11-05

### Added
- Offline-first, installable PWA for building QR codes, with no accounts, ads or tracking.
- Code types: Wi-Fi (WPA default), text, URL, email, phone, SMS, contact (vCard), location and calendar event.
- Selectable error correction, adjustable quiet zone, custom code color, and transparent or solid backgrounds.
- An optional description above the code and decoded text below it.
- Export to PNG, PDF (page cropped to the content, vector modules) and SVG, plus copy and share.
- History of generated codes in local storage, with search, pin, delete with undo, and JSON export/import.

[1.3.0]: https://github.com/mckoss/qrcode-builder/compare/0c6cbf2...v1.3.0
[1.2.2]: https://github.com/mckoss/qrcode-builder/compare/2bf9900...v1.2.2
[1.2.1]: https://github.com/mckoss/qrcode-builder/compare/9a1c981...2bf9900
[1.2.0]: https://github.com/mckoss/qrcode-builder/compare/d4483ec...9a1c981
[1.1.0]: https://github.com/mckoss/qrcode-builder/compare/367cb8f...d4483ec
[1.0.0]: https://github.com/mckoss/qrcode-builder/tree/367cb8f
