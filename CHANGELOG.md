# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/). The format is based on [Keep a Changelog](https://keepachangelog.com/).

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

[1.1.0]: https://github.com/mckoss/qrcode-builder/compare/367cb8f...v1.1.0
[1.0.0]: https://github.com/mckoss/qrcode-builder/tree/367cb8f
