// Data Wizard file generators. Every generator returns exactly sizeBytes bytes
// or throws; none may return a different size.
// PDF:  header + padding + trailer
// PNG:  real image + prVt ancillary padding chunk
// JPEG: fixed 8x8 JPEG + COM padding markers
// DOCX/XLSX: minimal OOXML package (STORE zip) whose thumbnail part is a padded JPEG

// -------- PDF --------

const PDF_HEADER =
  "%PDF-1.0\n" +
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 144 144]>>endobj\n" +
  "xref\n0 4\n" +
  "0000000000 65535 f \n" +
  "0000000009 00000 n \n" +
  "0000000052 00000 n \n" +
  "0000000101 00000 n \n" +
  "trailer<</Size 4/Root 1 0 R>>\n";

// Leading newline puts "startxref" on its own line; strict parsers require it.
const PDF_TRAILER = "\nstartxref\n164\n%%EOF";

const PDF_MIN_SIZE = PDF_HEADER.length + PDF_TRAILER.length;

/** Compressible PDF: header + 'x' padding + trailer. Exact target size. */
export function makePdfCompressible(sizeBytes) {
  if (sizeBytes < PDF_MIN_SIZE) {
    throw new Error(`PDF target must be at least ${PDF_MIN_SIZE} bytes`);
  }
  const enc = new TextEncoder();
  const header = enc.encode(PDF_HEADER);
  const trailer = enc.encode(PDF_TRAILER);
  const padLen = sizeBytes - header.length - trailer.length;
  const out = new Uint8Array(sizeBytes);
  out.set(header, 0);
  out.fill(0x78, header.length, header.length + padLen); // 'x'
  out.set(trailer, header.length + padLen);
  return out;
}

/** Uncompressible PDF: header + random padding + trailer. Exact target size. */
export function makePdfUncompressible(sizeBytes) {
  if (sizeBytes < PDF_MIN_SIZE) {
    throw new Error(`PDF target must be at least ${PDF_MIN_SIZE} bytes`);
  }
  const enc = new TextEncoder();
  const header = enc.encode(PDF_HEADER);
  const trailer = enc.encode(PDF_TRAILER);
  const padLen = sizeBytes - header.length - trailer.length;
  const out = new Uint8Array(sizeBytes);
  out.set(header, 0);
  fillRandom(out, header.length, padLen);
  out.set(trailer, header.length + padLen);
  return out;
}

// -------- PNG --------
// Format: signature + IHDR + IDAT (stored DEFLATE, no compression) + prVt padding + IEND
// prVt is a valid ancillary+private chunk that decoders ignore.

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

// Smallest exact PNG: 16x16 RGB image (sig 8 + IHDR 25 + IDAT 12+795 + IEND 12)
// plus an empty prVt chunk (12). Every size from here up is reachable.
const PNG_MIN_SIZE = 8 + 25 + (12 + 2 + 5 + 16 * (1 + 16 * 3) + 4) + 12 + 12;

/** Compressible PNG: tiny solid-color image + large prVt chunk of repeating 'x'. Exact size. */
export function makePngCompressible(sizeBytes) {
  return buildPng(sizeBytes, { mode: "compressible" });
}

/** Uncompressible PNG: random-pixel image sized close to target + prVt fill for exactness. */
export function makePngUncompressible(sizeBytes) {
  return buildPng(sizeBytes, { mode: "uncompressible" });
}

function buildPng(target, { mode }) {
  if (target < PNG_MIN_SIZE) {
    throw new Error(`PNG target must be at least ${PNG_MIN_SIZE} bytes`);
  }
  // Pick image dimensions
  let width, height;
  if (mode === "compressible") {
    // Tiny image; padding does the work
    width = 16;
    height = 16;
  } else {
    // Random pixels; fill as much of target as possible via IDAT.
    // Start from a rough estimate, then shrink until we fit under target with
    // room for the prVt padding chunk (12 bytes overhead).
    let w = Math.max(16, Math.floor(Math.sqrt(target / 3)));
    while (w > 16) {
      const rawScanline = 1 + w * 3;
      const rawSize = w * rawScanline;
      const zlibOverhead = 2 + 5 * Math.max(1, Math.ceil(rawSize / 65535)) + 4;
      const idatChunkSize = 12 + zlibOverhead + rawSize;
      const pngSoFar = 8 + 25 + idatChunkSize + 12; // sig + IHDR + IDAT + IEND
      if (pngSoFar + 12 <= target) break; // 12 = min prVt chunk overhead
      w--;
    }
    width = w;
    height = w;
  }

  const rawScanline = 1 + width * 3;
  const rawSize = height * rawScanline;
  const rawPixels = new Uint8Array(rawSize);

  if (mode === "compressible") {
    // Solid dark green (matches our accent). Filter byte 0, then RGB repeats.
    for (let y = 0; y < height; y++) {
      const rowStart = y * rawScanline;
      rawPixels[rowStart] = 0; // filter: None
      for (let x = 0; x < width; x++) {
        const p = rowStart + 1 + x * 3;
        rawPixels[p] = 0x2E;
        rawPixels[p + 1] = 0x3A;
        rawPixels[p + 2] = 0x2C;
      }
    }
  } else {
    // Random pixels. Filter byte MUST be 0-4; set to 0 per scanline.
    // Fill everything random first, then overwrite filter bytes.
    fillRandom(rawPixels, 0, rawSize);
    for (let y = 0; y < height; y++) {
      rawPixels[y * rawScanline] = 0;
    }
  }

  const idatPayload = zlibStored(rawPixels);
  const idatChunk = makeChunk("IDAT", idatPayload);
  const ihdrChunk = makeIhdr(width, height);
  const iendChunk = makeChunk("IEND", new Uint8Array(0));

  const currentSize =
    PNG_SIGNATURE.length + ihdrChunk.length + idatChunk.length + iendChunk.length;

  if (currentSize > target) {
    // Only possible for absurdly tiny targets; caller should validate min size upfront.
    throw new Error(
      `PNG cannot fit in ${target} bytes (minimum ~${currentSize})`,
    );
  }

  // Padding chunk (prVt) to reach exact target.
  const padChunkOverhead = 12; // length(4) + type(4) + crc(4)
  const padSize = target - currentSize - padChunkOverhead;

  if (padSize < 0) {
    // Cannot happen for target >= PNG_MIN_SIZE; never return a wrong size.
    throw new Error(`PNG cannot hit exactly ${target} bytes`);
  }
  const padData = new Uint8Array(padSize);
  if (mode === "compressible") {
    padData.fill(0x78); // 'x'
  } else {
    fillRandom(padData, 0, padSize);
  }
  const prVtChunk = makeChunk("prVt", padData);

  // Assemble: signature, IHDR, IDAT, prVt (padding), IEND
  const total = PNG_SIGNATURE.length + ihdrChunk.length + idatChunk.length +
    prVtChunk.length + iendChunk.length;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(PNG_SIGNATURE, off); off += PNG_SIGNATURE.length;
  out.set(ihdrChunk, off); off += ihdrChunk.length;
  out.set(idatChunk, off); off += idatChunk.length;
  out.set(prVtChunk, off); off += prVtChunk.length;
  out.set(iendChunk, off);
  return out;
}

function makeIhdr(width, height) {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  data[8] = 8;   // bit depth
  data[9] = 2;   // color type: RGB (truecolor)
  data[10] = 0;  // compression: deflate
  data[11] = 0;  // filter: standard
  data[12] = 0;  // interlace: none
  return makeChunk("IHDR", data);
}

/** Build a PNG chunk: length(4 BE) | type(4) | data | CRC32(4 BE) of type+data. */
function makeChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  if (typeBytes.length !== 4) throw new Error("chunk type must be 4 ASCII bytes");
  const len = data.length;
  const chunk = new Uint8Array(4 + 4 + len + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, len, false);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crc = crc32(chunk, 4, 8 + len);
  view.setUint32(8 + len, crc, false);
  return chunk;
}

/** zlib-wrapped DEFLATE with only stored (uncompressed) blocks. Valid but not compressed. */
function zlibStored(data) {
  const CHUNK = 65535;
  const numBlocks = data.length === 0 ? 1 : Math.ceil(data.length / CHUNK);
  const out = new Uint8Array(2 + numBlocks * 5 + data.length + 4);
  let off = 0;

  // zlib header: CMF=0x78 (deflate, 32K window), FLG=0x01 (fastest, FCHECK makes 0x7801 % 31 == 0)
  out[off++] = 0x78;
  out[off++] = 0x01;

  if (data.length === 0) {
    // Single empty final stored block
    out[off++] = 0x01; // BFINAL=1, BTYPE=00
    out[off++] = 0x00; out[off++] = 0x00; // LEN=0
    out[off++] = 0xFF; out[off++] = 0xFF; // NLEN=~0
  } else {
    let pos = 0;
    while (pos < data.length) {
      const blockLen = Math.min(CHUNK, data.length - pos);
      const isFinal = pos + blockLen >= data.length;
      out[off++] = isFinal ? 0x01 : 0x00; // BFINAL | BTYPE=00
      out[off++] = blockLen & 0xFF;
      out[off++] = (blockLen >>> 8) & 0xFF;
      const nlen = (~blockLen) & 0xFFFF;
      out[off++] = nlen & 0xFF;
      out[off++] = (nlen >>> 8) & 0xFF;
      out.set(data.subarray(pos, pos + blockLen), off);
      off += blockLen;
      pos += blockLen;
    }
  }

  // Adler32 trailer (big-endian)
  const adler = adler32(data);
  new DataView(out.buffer).setUint32(off, adler, false);
  off += 4;

  return out.subarray(0, off);
}

// -------- JPEG --------
// Format: minimal real JPEG + COM markers stuffed with padding to reach exact target.
// COM (0xFFFE) markers are legal anywhere between SOI and EOI and are skipped by all decoders.
// Each marker: FF FE | LEN(2 BE, includes length bytes) | payload(LEN-2)
// Min marker size = 4 (empty payload). Max marker size = 65537 (LEN=0xFFFF, payload=65533).

const JPEG_COM_MIN = 4;
const JPEG_COM_MAX = 65537;

// Fixed 8x8 baseline JPEG (solid #2E3A2C, quality 50, 631 bytes). Embedded
// rather than drawn on a canvas so output is identical in every browser and
// the minimum size is known up front.
const JPEG_TEMPLATE = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDmaKKKkk//2Q==",
  ),
  (c) => c.charCodeAt(0),
);

// Smallest padded JPEG. (Padding of 1-3 bytes is impossible, so the bare
// template size is excluded to keep the valid range gap-free.)
const JPEG_MIN_SIZE = JPEG_TEMPLATE.length + JPEG_COM_MIN;

export function makeJpegCompressible(sizeBytes) {
  return padJpeg(JPEG_TEMPLATE, sizeBytes, "compressible");
}

export function makeJpegUncompressible(sizeBytes) {
  return padJpeg(JPEG_TEMPLATE, sizeBytes, "uncompressible");
}

function padJpeg(template, target, mode) {
  if (template[0] !== 0xFF || template[1] !== 0xD8) {
    throw new Error("Invalid JPEG template (missing SOI marker)");
  }
  if (target < template.length) {
    throw new Error(
      `JPEG target ${target} smaller than template ${template.length}`,
    );
  }
  const padding = target - template.length;
  if (padding > 0 && padding < JPEG_COM_MIN) {
    throw new Error(
      `JPEG requires 0 or >=${JPEG_COM_MIN} padding bytes (got ${padding})`,
    );
  }

  if (padding === 0) return new Uint8Array(template);

  // Distribute padding across COM markers (each between JPEG_COM_MIN and JPEG_COM_MAX)
  const markerSizes = distributeJpegMarkers(padding);

  // Layout: SOI (2 bytes) | COM markers | rest of template (from offset 2)
  const out = new Uint8Array(target);
  out[0] = 0xFF;
  out[1] = 0xD8;
  let off = 2;

  for (const size of markerSizes) {
    out[off] = 0xFF;
    out[off + 1] = 0xFE;
    const len = size - 2; // LEN field includes itself
    out[off + 2] = (len >>> 8) & 0xFF;
    out[off + 3] = len & 0xFF;
    const payloadOff = off + 4;
    const payloadLen = size - 4;
    if (mode === "compressible") {
      out.fill(0x78, payloadOff, payloadOff + payloadLen); // 'x'
    } else {
      fillRandom(out, payloadOff, payloadLen);
    }
    off += size;
  }

  out.set(template.subarray(2), off);
  return out;
}

function distributeJpegMarkers(total) {
  const k = Math.max(1, Math.ceil(total / JPEG_COM_MAX));
  const base = Math.floor(total / k);
  const extra = total - base * k;
  const sizes = new Array(k);
  for (let i = 0; i < k; i++) sizes[i] = base + (i < extra ? 1 : 0);
  return sizes;
}

// -------- Office (DOCX / XLSX) --------
// A minimal OOXML package written as an uncompressed (STORE) zip. Padding lives
// in docProps/thumbnail.jpeg: the standard OPC package-thumbnail part, linked
// from _rels/.rels, which Word and Excel themselves write when "save preview
// picture" is on. The thumbnail is a padded JPEG sized so the whole file hits
// the target exactly. STORE keeps the padding's compressibility visible to
// HTTP gzip, which is the point of the compressible/uncompressible split.

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const NS_PR = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_OR = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const CT_OOXML = "application/vnd.openxmlformats-officedocument";
const THUMB_PART = "docProps/thumbnail.jpeg";
const BODY_TEXT = "Data Wizard test file";

const rootRels = (mainPart) =>
  XML_DECL +
  `<Relationships xmlns="${NS_PR}">` +
  `<Relationship Id="rId1" Type="${NS_OR}/officeDocument" Target="${mainPart}"/>` +
  `<Relationship Id="rId2" Type="${NS_PR}/metadata/thumbnail" Target="${THUMB_PART}"/>` +
  `</Relationships>`;

const contentTypes = (overrides) =>
  XML_DECL +
  `<Types xmlns="${NS_CT}">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
  overrides.map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join("") +
  `</Types>`;

const OFFICE_PARTS = {
  docx: [
    ["[Content_Types].xml", contentTypes([
      ["word/document.xml", `${CT_OOXML}.wordprocessingml.document.main+xml`],
    ])],
    ["_rels/.rels", rootRels("word/document.xml")],
    ["word/document.xml",
      XML_DECL +
      `<w:document xmlns:w="${NS_W}"><w:body>` +
      `<w:p><w:r><w:t>${BODY_TEXT}</w:t></w:r></w:p>` +
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
      `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>` +
      `</w:sectPr></w:body></w:document>`],
  ],
  xlsx: [
    ["[Content_Types].xml", contentTypes([
      ["xl/workbook.xml", `${CT_OOXML}.spreadsheetml.sheet.main+xml`],
      ["xl/worksheets/sheet1.xml", `${CT_OOXML}.spreadsheetml.worksheet+xml`],
      ["xl/styles.xml", `${CT_OOXML}.spreadsheetml.styles+xml`],
    ])],
    ["_rels/.rels", rootRels("xl/workbook.xml")],
    ["xl/workbook.xml",
      XML_DECL +
      `<workbook xmlns="${NS_S}" xmlns:r="${NS_OR}">` +
      `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels",
      XML_DECL +
      `<Relationships xmlns="${NS_PR}">` +
      `<Relationship Id="rId1" Type="${NS_OR}/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="${NS_OR}/styles" Target="styles.xml"/>` +
      `</Relationships>`],
    ["xl/worksheets/sheet1.xml",
      XML_DECL +
      `<worksheet xmlns="${NS_S}"><sheetData>` +
      `<row r="1"><c r="A1" t="inlineStr"><is><t>${BODY_TEXT}</t></is></c></row>` +
      `</sheetData></worksheet>`],
    ["xl/styles.xml",
      XML_DECL +
      `<styleSheet xmlns="${NS_S}">` +
      `<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>` +
      `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`],
  ],
};

const ZIP_LOCAL = 30;
const ZIP_CENTRAL = 46;
const ZIP_EOCD = 22;

/** Bytes used by everything except the thumbnail's data. */
function officeFixedSize(kind) {
  const enc = new TextEncoder();
  let n = ZIP_EOCD + ZIP_LOCAL + ZIP_CENTRAL + 2 * THUMB_PART.length;
  for (const [name, text] of OFFICE_PARTS[kind]) {
    n += ZIP_LOCAL + ZIP_CENTRAL + 2 * name.length + enc.encode(text).length;
  }
  return n;
}

const DOCX_MIN_SIZE = officeFixedSize("docx") + JPEG_MIN_SIZE;
const XLSX_MIN_SIZE = officeFixedSize("xlsx") + JPEG_MIN_SIZE;

function buildOffice(kind, target, mode) {
  const fixed = officeFixedSize(kind);
  if (target < fixed + JPEG_MIN_SIZE) {
    throw new Error(`${kind.toUpperCase()} target must be at least ${fixed + JPEG_MIN_SIZE} bytes`);
  }
  const enc = new TextEncoder();
  const entries = OFFICE_PARTS[kind].map(([name, text]) => [name, enc.encode(text)]);
  entries.push([THUMB_PART, padJpeg(JPEG_TEMPLATE, target - fixed, mode)]);
  return storeZip(entries, target);
}

/** Uncompressed zip (no data descriptors, no extra fields). Size is exact by construction. */
function storeZip(entries, expectedSize) {
  const out = new Uint8Array(expectedSize);
  const view = new DataView(out.buffer);
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const records = [];
  let off = 0;

  for (const [name, data] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data, 0, data.length);
    records.push({ nameBytes, crc, size: data.length, offset: off });
    view.setUint32(off, 0x04034B50, true);
    view.setUint16(off + 4, 20, true);       // version needed
    view.setUint16(off + 6, 0, true);        // flags
    view.setUint16(off + 8, 0, true);        // method: STORE
    view.setUint16(off + 10, dosTime, true);
    view.setUint16(off + 12, dosDate, true);
    view.setUint32(off + 14, crc, true);
    view.setUint32(off + 18, data.length, true);
    view.setUint32(off + 22, data.length, true);
    view.setUint16(off + 26, nameBytes.length, true);
    view.setUint16(off + 28, 0, true);       // extra length
    out.set(nameBytes, off + ZIP_LOCAL);
    off += ZIP_LOCAL + nameBytes.length;
    out.set(data, off);
    off += data.length;
  }

  const cdStart = off;
  for (const r of records) {
    view.setUint32(off, 0x02014B50, true);
    view.setUint16(off + 4, 20, true);       // version made by
    view.setUint16(off + 6, 20, true);       // version needed
    view.setUint16(off + 8, 0, true);
    view.setUint16(off + 10, 0, true);
    view.setUint16(off + 12, dosTime, true);
    view.setUint16(off + 14, dosDate, true);
    view.setUint32(off + 16, r.crc, true);
    view.setUint32(off + 20, r.size, true);
    view.setUint32(off + 24, r.size, true);
    view.setUint16(off + 28, r.nameBytes.length, true);
    // extra len, comment len, disk, internal attrs, external attrs: all 0
    view.setUint32(off + 42, r.offset, true);
    out.set(r.nameBytes, off + ZIP_CENTRAL);
    off += ZIP_CENTRAL + r.nameBytes.length;
  }

  view.setUint32(off, 0x06054B50, true);
  view.setUint16(off + 8, records.length, true);
  view.setUint16(off + 10, records.length, true);
  view.setUint32(off + 12, off - cdStart, true);
  view.setUint32(off + 16, cdStart, true);
  off += ZIP_EOCD;

  if (off !== expectedSize) {
    throw new Error(`zip size ${off} != target ${expectedSize}`);
  }
  return out;
}

export function makeDocxCompressible(sizeBytes) {
  return buildOffice("docx", sizeBytes, "compressible");
}
export function makeDocxUncompressible(sizeBytes) {
  return buildOffice("docx", sizeBytes, "uncompressible");
}
export function makeXlsxCompressible(sizeBytes) {
  return buildOffice("xlsx", sizeBytes, "compressible");
}
export function makeXlsxUncompressible(sizeBytes) {
  return buildOffice("xlsx", sizeBytes, "uncompressible");
}

// -------- Minimum sizes --------

/** Smallest valid target per format, in bytes. Every size at or above it is exact. */
export const MIN_BYTES = {
  pdf: PDF_MIN_SIZE,
  png: PNG_MIN_SIZE,
  jpeg: JPEG_MIN_SIZE,
  docx: DOCX_MIN_SIZE,
  xlsx: XLSX_MIN_SIZE,
};

// -------- Checksums --------

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  const MOD = 65521;
  // Process in chunks to avoid overflow (safe up to ~5552 bytes per inner loop)
  const NMAX = 5552;
  let i = 0;
  while (i < bytes.length) {
    const end = Math.min(i + NMAX, bytes.length);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

// -------- Utils --------

/** Fill a range of a Uint8Array with crypto-random bytes, chunked to respect the 65536 API limit. */
function fillRandom(buf, offset, length) {
  const MAX = 65536;
  let written = 0;
  while (written < length) {
    const chunk = Math.min(MAX, length - written);
    crypto.getRandomValues(buf.subarray(offset + written, offset + written + chunk));
    written += chunk;
  }
}
