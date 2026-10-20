# Data Wizard

Byte-precise test file generator for load and upload testing. Part of the Performance Suite (accent `#B48AE8`, wand chip). Runs entirely in the browser, downloads as a zip. No server, no upload, no network access.

## What it produces

- **PDF, compressible**: valid minimal PDF padded with `'x'` bytes to exact target size.
- **PDF, uncompressible**: same header/trailer, random-byte padding. Defeats gzip/DEFLATE.
- **PNG, compressible**: 16×16 solid image with a large `prVt` ancillary chunk of repeating `'x'`.
- **PNG, uncompressible**: random-pixel RGB image sized to target, with `prVt` fill for byte-exact matching.
- **JPEG, compressible**: 8×8 real JPEG padded via `COM` markers filled with `'x'`.
- **JPEG, uncompressible**: 8×8 real JPEG with `COM` markers of random bytes.
- **DOCX / XLSX, compressible**: minimal Word / Excel package (one line of text) whose package thumbnail is a padded JPEG of `'x'` bytes.
- **DOCX / XLSX, uncompressible**: same package, thumbnail padded with random bytes.

Every file lands at its exact target size; a generator either hits the size or throws.

## Sizes

- **Range:** Start / Step / Max in KB or MB (whole numbers).
- **List:** comma-separated sizes with units B, KB or MB, decimals allowed (`250KB, 1.5MB, 5242879B`). Sorted ascending; duplicates rejected.
- **Boundary:** one or more limits (same syntax as List) plus an offset in bytes (default 1). Each limit gives three files: `limit − offset`, `limit`, `limit + offset`, named `PDF_5MB_minus1B.pdf`, `PDF_5MB_exact.pdf`, `PDF_5MB_plus1B.pdf`. For a server that counts MB as 1,000,000 bytes, enter the limit in bytes (`5000000B`).
- KB = 1,024 B, MB = 1,048,576 B. Decimal sizes round to the nearest byte; the file list shows the exact bytes.
- Up to 500 sizes per set. More is rejected, never truncated.
- Minimum sizes: PDF 303 B, PNG 864 B, JPEG 635 B, DOCX 2,417 B, XLSX 4,299 B. Anything smaller is rejected inline.

## Layout

```
src/                  source (edit here)
  index.html
  styles.css          suite "JMeter Darcula" theme
  app.js              UI and zip streaming
  generators.js       file generators
  favicon.svg
  vendor/client-zip.js  client-zip 2.4.5 (MIT), vendored, no CDN
build.mjs             zero-dependency build
dist/index.html       single self-contained file (the distributable)
```

## Build

```
node build.mjs
```

Inlines CSS, favicon and all JS modules into `dist/index.html`. The build fails loudly if it meets an import/export form it doesn't handle.

## Run

- **Air-gapped / local:** open `dist/index.html` directly (file:// works).
- **GitHub Pages:** publish `dist/index.html` as the site's `index.html`.
- **Developing:** `src/` uses ES modules, so serve it over HTTP (`python -m http.server` inside `src/`); file:// does not work for the source version.

## Browser support

- **Chrome / Edge:** `showSaveFilePicker` streams the zip straight to disk.
- **Firefox / Safari:** buffers the zip as a blob before download. Works up to a few hundred MB depending on the machine.

## How the byte-exact sizing works

- **PDF:** `header_len + padding_len + trailer_len = target`. `startxref` sits on its own line, so strict parsers (pypdf strict, qpdf) accept it.
- **PNG:** real PNG (signature + IHDR + IDAT + IEND) plus a `prVt` ancillary private chunk sized to hit the target. Conformant decoders ignore it.
- **JPEG:** fixed 8×8 baseline JPEG embedded in the code (631 bytes, identical output in every browser), with `COM` (`0xFFFE`) markers after `SOI` sized to hit the target. Max 65,533 bytes per marker, so large padding uses several.
- **DOCX / XLSX:** uncompressed (STORE) zip with no data descriptors, so the size is exact by construction. Padding goes in `docProps/thumbnail.jpeg`, the standard package-thumbnail part Office itself writes. Verified with python-docx, openpyxl and LibreOffice; not yet opened in Microsoft Office.

## Tech notes

- Vanilla HTML/CSS/JS, system fonts, inline SVG icons. No external requests.
- Zip entries use `STORE`, so the `.zip` size is roughly the sum of file sizes.
- Randomness from `crypto.getRandomValues` (chunked to the 65,536-byte per-call limit).
