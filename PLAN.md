# Plan and backlog

## Backlog

### Multi-code documents: large text, audio and video on paper

**Status:** idea / discussion. Nothing is built yet.

**Goal:** encode a file much larger than one QR code holds (about 100 pages of text, a short audio clip) as a set of codes printed across several pages. The codes can be scanned in any order. The app shows which codes are still needed, then reassembles and verifies the file.

#### Is it feasible? Rough numbers

A single QR code tops out at 2,953 bytes (version 40, error correction L, binary). That density is hard to read from a printed page with a phone. A practical target is a mid-size code (around version 20–25, error correction M) printed about 2 inches wide, which carries **roughly 0.7–1 KB** of data. A Letter or A4 page fits about 12 of them with labels, so **about 8–12 KB per page**.

| Content | Raw size | After compression | Codes (~0.8 KB each) | Pages (12 per page, +15% parity) |
| --- | --- | --- | --- | --- |
| 100 pages of plain text (~3,000 chars/page) | ~300 KB | ~90–100 KB (deflate/Brotli, ~3:1 for prose) | ~120 | **~12** |
| 1 minute of speech, Opus at 8–12 kbps | — | 60–90 KB | ~75–110 | ~8–11 per minute |
| 1 minute of speech, Codec2 at 1.2–3.2 kbps (robotic but intelligible) | — | 9–24 KB | ~12–30 | ~1–3 per minute |
| 1 minute of music, Opus at 32 kbps | — | ~240 KB | ~300 | ~30 per minute |
| 1 minute of tiny video (very low resolution, 30–60 kbps) | — | 225–450 KB | 280–560 | 25–50 per minute |

Conclusions:

- **Text is very practical.** A 100-page book becomes about a dozen printed pages.
- **Short speech clips are practical.** Music is marginal, and video on paper is not realistic beyond a few seconds.
- Video and large files fit a different medium better: an **animated code on a screen**, scanned by another device's camera. A fountain-coded stream of QR frames moves on the order of 5–20 KB/s with no paper involved.
- Purpose-built paper formats such as Optar and PaperBack reach much higher density, up to hundreds of KB per page. They use custom codes and need a flatbed scanner rather than a phone. Phone-scannable QR trades density for convenience.

#### Protocol sketch

Every code carries a small binary header, so any single code identifies its file and position:

```
magic "QB" | protocol version | flags | transfer id (8 random bytes)
| k = data chunks | n = total chunks (data + parity) | chunk index | chunk data
```

That's about 16–18 bytes of overhead per code.

- **Transfer id:** prevents mixing chunks from two different documents, and lets scans resume later.
- **Encoding:** binary packed with **Base45** in QR alphanumeric mode (RFC 9285, as used by EU COVID certificates). Base45 survives every decoder, including the browser's native `BarcodeDetector`, which returns text and can corrupt raw binary.
  - Base45 costs about 25% capacity versus raw byte mode.
  - The alternative is raw binary plus jsQR's `binaryData`, which is denser but works only with our own decoder.
- **Manifest:** printed as a small extra code in every page header. It holds:
  - file name, MIME type and original size;
  - compression method;
  - chunk size, `k` and `n`, and the parity scheme;
  - a SHA-256 hash of the original file.

  Repeating it on every page means any page can start the scan.
- **Compression:** the browser's built-in `CompressionStream('deflate-raw')` for text, so no extra library. Audio and video arrive already compressed.
- **Erasure coding:**
  - **Reed–Solomon parity across chunks** (systematic, maximum distance separable). Any `k` of the `n` chunks rebuild the file, so smudged codes, a torn corner or even a missing page are tolerated. Parity overhead is configurable, for example 10–25%, or "one extra page in ten".
  - GF(256) Reed–Solomon limits a block to 255 chunks, so larger documents are split into independent stripes, each reported separately.
  - **Fountain codes** (LT or RaptorQ) have no block limit and suit the animated-screen mode. Printed sets are better served by Reed–Solomon's exact counts ("you need any 9 more codes").
- **Integrity:** the QR code's own error correction rejects most bad reads. The final SHA-256 check confirms the reconstruction. A per-chunk CRC is optional.
- **Encryption (optional):** a passphrase-derived key (PBKDF2 or Argon2, then AES-GCM via WebCrypto), for sensitive documents on paper.

#### Printing

- A multi-page PDF from the existing jsPDF pipeline.
- Each page has:
  - a header: title, short transfer id, "page 3 of 12", the manifest code, and one line of scanning instructions;
  - a grid of codes, each labeled underneath, e.g. `p3 · #31 of 138`.
- Error correction M by default, and modules at least about 0.33 mm. Include a "print a test page" option.

#### Scanning and reconstruction

- **Continuous multi-code scanning:**
  - `BarcodeDetector` can return many codes per camera frame, so a whole page may register at once.
  - jsQR reads one code at a time; tiling the frame would extend it to several.
- **Progress screen:**
  - "103 of 120 needed"; with parity, "any 17 more".
  - A per-page grid that lights up as codes are read, so missing ones are obvious: "still needed: p4 #40, #41 · p9 #105".
  - Haptic or audible feedback per new code. Duplicates are ignored.
- Partial progress is saved, in IndexedDB rather than localStorage given the size, so a scan can resume later or continue on another day.
- **When complete:** verify the hash, decompress, then show the text, play the audio, or offer the file for download.

#### How it fits the app

- A new "Document" mode alongside single codes.
- Library caveat: the library stores source data, and a document's source is the whole file. Documents would need to:
  - live in IndexedDB rather than the localStorage library; or
  - be kept only as a small library record (name, size, hash, transfer id) with the file re-supplied to reprint.
- Everything stays offline and client-side, as now.

#### Suggested phases

1. **Spike:** measure real-world read rates on paper with a few phones for code versions 15–30 at different printed sizes. Pick the chunk size and default parity from data, not from the guesses above.
2. **Large-text MVP:** compression, Base45 chunks, page layout and PDF, multi-code scanning with progress, reassembly and hash check. No parity yet.
3. **Reliability:** Reed–Solomon parity with striping, "codes still needed" guidance, and resumable progress.
4. **Any file:** generic files with MIME type, starting with audio the user has already compressed (e.g. Opus or AAC). In-app recording and encoding (WebCodecs or WASM Opus/Codec2) comes later.
5. **Optional:**
   - an animated screen-to-screen mode with fountain codes, for larger files and video;
   - passphrase encryption.

#### Open questions

- Is printing the main target, or would on-screen transfer between devices be just as useful? That affects whether phase 5 comes earlier.
- Should a reconstructed document go into the library, or only be shown and downloaded?
- Must codes be readable by generic QR apps (each shows a meaningless chunk), or only by this app? Base45 versus binary is the trade-off.
- Should printed pages be self-describing (protocol notes in the footer) so the data stays recoverable without this app in the future?
