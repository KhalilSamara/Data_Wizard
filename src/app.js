import { downloadZip } from "./vendor/client-zip.js";
import {
  makePdfCompressible,
  makePdfUncompressible,
  makePngCompressible,
  makePngUncompressible,
  makeJpegCompressible,
  makeJpegUncompressible,
  makeDocxCompressible,
  makeDocxUncompressible,
  makeXlsxCompressible,
  makeXlsxUncompressible,
  MIN_BYTES,
} from "./generators.js";

// ---------- Config ----------

const KB = 1024;
const MB = 1024 * 1024;
const UNIT_BYTES = { B: 1, KB, MB };
const WARN_TOTAL_BYTES = 500 * MB;
const MAX_SIZES = 500; // per set; above this the input is rejected, never truncated

const TYPES = {
  "pdf-comp": { kind: "pdf", dir: "PDF_Compressible", ext: "pdf", prefix: "PDF", make: makePdfCompressible },
  "pdf-unc": { kind: "pdf", dir: "PDF_Uncompressible", ext: "pdf", prefix: "PDF", make: makePdfUncompressible },
  "png-comp": { kind: "png", dir: "PNG_Compressible", ext: "png", prefix: "PNG", make: makePngCompressible },
  "png-unc": { kind: "png", dir: "PNG_Uncompressible", ext: "png", prefix: "PNG", make: makePngUncompressible },
  "jpeg-comp": { kind: "jpeg", dir: "JPEG_Compressible", ext: "jpg", prefix: "JPEG", make: makeJpegCompressible },
  "jpeg-unc": { kind: "jpeg", dir: "JPEG_Uncompressible", ext: "jpg", prefix: "JPEG", make: makeJpegUncompressible },
  "docx-comp": { kind: "docx", dir: "DOCX_Compressible", ext: "docx", prefix: "DOCX", make: makeDocxCompressible },
  "docx-unc": { kind: "docx", dir: "DOCX_Uncompressible", ext: "docx", prefix: "DOCX", make: makeDocxUncompressible },
  "xlsx-comp": { kind: "xlsx", dir: "XLSX_Compressible", ext: "xlsx", prefix: "XLSX", make: makeXlsxCompressible },
  "xlsx-unc": { kind: "xlsx", dir: "XLSX_Uncompressible", ext: "xlsx", prefix: "XLSX", make: makeXlsxUncompressible },
};

// ---------- DOM references ----------

const $ = (id) => document.getElementById(id);
const form = $("config");
const startEl = $("size-start");
const stepEl = $("size-step");
const maxEl = $("size-max");
const listEl = $("size-list");
const limitsEl = $("size-limits");
const offsetEl = $("size-offset");
const rangeFields = $("range-fields");
const listFields = $("list-fields");
const boundaryFields = $("boundary-fields");
const unitSeg = $("unit-seg");
const previewEl = $("size-preview");
const errEls = {
  start: $("err-start"), step: $("err-step"), max: $("err-max"), list: $("err-list"),
  limits: $("err-limits"), offset: $("err-offset"), sizes: $("err-sizes"),
};
const inputFor = { start: startEl, step: stepEl, max: maxEl, list: listEl, limits: limitsEl, offset: offsetEl };
const zipNameEl = $("zip-name");
const metaEl = $("meta");
const statusEl = $("status");
const warningEl = $("warning");
const treeEl = $("tree");
const emptyEl = $("empty");
const emptyMsgEl = $("empty-msg");
const generateBtn = $("generate");
const generateLabel = $("generate-label");
const copyBtn = $("copy");
const copyLabel = $("copy-label");

let manifestText = ""; // exactly what Copy puts on the clipboard
let busy = false;

// ---------- State ----------

function readState() {
  const types = [...form.querySelectorAll('input[name="type"]:checked')].map((el) => el.value);
  const mode = form.querySelector('input[name="size-mode"]:checked').value;
  const unit = form.querySelector('input[name="size-unit"]:checked').value;
  return {
    types,
    mode,
    unit,
    start: numOrNull(startEl.value),
    step: numOrNull(stepEl.value),
    max: numOrNull(maxEl.value),
    listText: listEl.value,
    limitsText: limitsEl.value,
    offset: numOrNull(offsetEl.value),
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && Math.floor(n) === n ? n : null;
}

const fmtNum = (n) => n.toLocaleString("en-US");

// Parses "250KB, 1.5MB, 5242879B" into [{ bytes, num, unit }] (input order).
function parseSizeList(text) {
  const tokens = text.split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return { err: "Enter at least one size" };
  const out = [];
  const seen = new Map();
  for (const tok of tokens) {
    const m = tok.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb)$/i);
    if (!m) return { err: `Not a size: ${tok}` };
    const num = Number(m[1]);
    const unit = m[2].toUpperCase();
    const bytes = Math.round(num * UNIT_BYTES[unit]);
    if (bytes < 1) return { err: `Too small: ${tok}` };
    const label = `${num}${unit}`;
    if (seen.has(bytes)) {
      const prev = seen.get(bytes);
      return { err: prev === label ? `Listed twice: ${label}` : `Same size twice: ${prev} and ${label}` };
    }
    seen.set(bytes, label);
    out.push({ bytes, num, unit });
  }
  return { items: out };
}

const plainSize = ({ bytes, num, unit }) => ({ bytes, label: `${num}${unit}`, display: `${num} ${unit}` });

// Returns { sizes: [{ bytes, label, display }], errs }. label goes into file
// names. sizes is empty whenever any error is set, so nothing invalid can
// reach generation.
function computeSizes(state) {
  const errs = { start: "", step: "", max: "", list: "", limits: "", offset: "", sizes: "" };
  let sizes = [];

  if (state.mode === "boundary") {
    if (!state.offset) errs.offset = "Whole number, 1 or more";
    const parsed = parseSizeList(state.limitsText);
    if (parsed.err) errs.limits = parsed.err;
    if (!errs.offset && !errs.limits) {
      const d = state.offset;
      const seen = new Map();
      for (const lim of parsed.items.sort((a, b) => a.bytes - b.bytes)) {
        const base = `${lim.num}${lim.unit}`;
        if (lim.bytes - d < 1) { errs.offset = `Offset must be below ${base}`; break; }
        const trio = [
          { bytes: lim.bytes - d, label: `${base}_minus${d}B`, display: `${lim.num} ${lim.unit} − ${d} B` },
          { bytes: lim.bytes, label: `${base}_exact`, display: `${lim.num} ${lim.unit}` },
          { bytes: lim.bytes + d, label: `${base}_plus${d}B`, display: `${lim.num} ${lim.unit} + ${d} B` },
        ];
        for (const s of trio) {
          if (seen.has(s.bytes)) {
            errs.limits = `Limits overlap at ${fmtNum(s.bytes)} B (${seen.get(s.bytes)} and ${s.label})`;
            break;
          }
          seen.set(s.bytes, s.label);
          sizes.push(s);
        }
        if (errs.limits) break;
      }
      if (!errs.limits && !errs.offset && sizes.length > MAX_SIZES) {
        errs.limits = `${fmtNum(sizes.length)} sizes; limit is ${MAX_SIZES}`;
      }
      sizes.sort((a, b) => a.bytes - b.bytes);
    }
  } else if (state.mode === "range") {
    const need = "Whole number, 1 or more";
    if (!state.start) errs.start = need;
    if (!state.step) errs.step = need;
    if (!state.max) errs.max = need;
    else if (state.start && state.max < state.start) errs.max = "Below Start";
    if (!errs.start && !errs.step && !errs.max) {
      const count = Math.floor((state.max - state.start) / state.step) + 1;
      if (count > MAX_SIZES) {
        errs.max = `${fmtNum(count)} sizes; limit is ${MAX_SIZES}`;
      } else {
        for (let s = state.start; s <= state.max; s += state.step) {
          sizes.push(plainSize({ bytes: s * UNIT_BYTES[state.unit], num: s, unit: state.unit }));
        }
      }
    }
  } else {
    const parsed = parseSizeList(state.listText);
    if (parsed.err) errs.list = parsed.err;
    else if (parsed.items.length > MAX_SIZES) errs.list = `${fmtNum(parsed.items.length)} sizes; limit is ${MAX_SIZES}`;
    else sizes = parsed.items.map(plainSize).sort((a, b) => a.bytes - b.bytes);
  }

  if (Object.values(errs).some(Boolean)) return { sizes: [], errs };

  // Format minimums (only for the formats actually selected)
  if (sizes.length && state.types.length) {
    const smallest = sizes[0].bytes;
    const kinds = [...new Set(state.types.map((k) => TYPES[k].kind))];
    const under = kinds.filter((k) => smallest < MIN_BYTES[k]);
    if (under.length) {
      errs.sizes = "Smallest size is below the minimum for " +
        under.map((k) => `${k.toUpperCase()} (${fmtNum(MIN_BYTES[k])} B)`).join(", ");
      return { sizes: [], errs };
    }
  }
  return { sizes, errs };
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / (1024 * MB)).toFixed(2)} GB`;
}

function fmtExact(n) {
  return `${fmtNum(n)} B`;
}

function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function buildFileSpecs(state, sizes) {
  const specs = [];
  for (const key of state.types) {
    const t = TYPES[key];
    for (const s of sizes) {
      specs.push({
        typeKey: key,
        dir: t.dir,
        name: `${t.prefix}_${s.label}.${t.ext}`,
        sizeBytes: s.bytes,
      });
    }
  }
  return specs;
}

function showFieldErrors(errs) {
  for (const key of Object.keys(errEls)) {
    errEls[key].textContent = errs[key];
    const input = inputFor[key];
    if (!input) continue;
    if (errs[key]) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }
}

// ---------- Rendering ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Builds the zip tree. Each line is a list of [class, text] tokens, so the
// coloured view and the copied plain text come from the same source.
function buildTree(specs, types, folderName) {
  const groups = [];
  for (const key of types) {
    const files = specs.filter((s) => s.typeKey === key);
    if (files.length) groups.push({ key, files });
  }

  const nameCol =
    Math.max(
      folderName.length + 1,
      ...groups.map((g) => 2 + g.files[0].dir.length + 1),
      ...specs.map((s) => 4 + s.name.length),
    ) + 4;
  const numW = Math.max(
    ...specs.map((s) => fmtExact(s.sizeBytes).length),
    ...groups.map((g) => fmtBytes(g.files.reduce((a, s) => a + s.sizeBytes, 0)).length),
  );
  const countW = Math.max(...groups.map((g) => `${g.files.length} files`.length));

  const lines = [];
  lines.push({ tokens: [["t-root", `${folderName}/`]] });
  for (const g of groups) {
    const dirText = `  ${g.files[0].dir}/`;
    const bytes = g.files.reduce((a, s) => a + s.sizeBytes, 0);
    const count = `${g.files.length} file${g.files.length === 1 ? "" : "s"}`;
    lines.push({
      tokens: [
        ["t-dir", dirText],
        ["", " ".repeat(nameCol - dirText.length)],
        ["t-cmt", count.padEnd(countW)],
        ["", "  "],
        ["t-num", fmtBytes(bytes).padStart(numW)],
      ],
    });
    for (const f of g.files) {
      const nameText = `    ${f.name}`;
      lines.push({
        spec: f,
        tokens: [
          ["t-file", nameText],
          ["", " ".repeat(nameCol - nameText.length + countW + 2)],
          ["t-num", fmtExact(f.sizeBytes).padStart(numW)],
        ],
      });
    }
  }
  return lines;
}

function renderTree(lines) {
  const frag = document.createDocumentFragment();
  const plain = [];
  let fileIdx = 0;
  for (const line of lines) {
    const span = el("span", "ln");
    if (line.spec) span.dataset.i = String(fileIdx++);
    let text = "";
    for (const [cls, t] of line.tokens) {
      text += t;
      span.appendChild(cls ? el("span", cls, t) : document.createTextNode(t));
    }
    plain.push(text);
    frag.appendChild(span);
    frag.appendChild(document.createTextNode("\n"));
  }
  treeEl.replaceChildren(frag);
  return plain.join("\n") + "\n";
}

function renderMeta(setCount, totalFiles, totalBytes) {
  const items = [
    [String(setCount), setCount === 1 ? " set" : " sets"],
    [fmtNum(totalFiles), totalFiles === 1 ? " file" : " files"],
    [fmtBytes(totalBytes), ""],
  ];
  const frag = document.createDocumentFragment();
  for (const [num, unit] of items) {
    const s = el("span");
    s.appendChild(el("b", "", num));
    if (unit) s.appendChild(document.createTextNode(unit));
    frag.appendChild(s);
  }
  if (totalBytes > WARN_TOTAL_BYTES) frag.appendChild(el("span", "flag", "> 500 MB"));
  metaEl.replaceChildren(frag);
}

function render({ clearStatus = true } = {}) {
  const state = readState();

  // Mode-dependent controls
  const isRange = state.mode === "range";
  rangeFields.hidden = !isRange;
  listFields.hidden = state.mode !== "list";
  boundaryFields.hidden = state.mode !== "boundary";
  unitSeg.hidden = !isRange;
  for (const u of form.querySelectorAll(".range-unit")) u.textContent = state.unit;

  const { sizes, errs } = computeSizes(state);
  showFieldErrors(errs);
  const sizesValid = !Object.values(errs).some(Boolean);

  // Size preview line
  if (sizesValid && sizes.length) {
    const shown = sizes.slice(0, 12).map((s) => s.display).join(", ");
    const suffix = sizes.length > 12 ? `, … (${sizes.length} total)` : "";
    previewEl.textContent = `Sizes: ${shown}${suffix}`;
  } else {
    previewEl.textContent = "";
  }

  // Zip filename
  const folderName = `DataWizard_${todayISO()}`;
  zipNameEl.textContent = `${folderName}.zip`;

  // Manifest
  const specs = buildFileSpecs(state, sizes);
  const totalFiles = specs.length;
  const totalBytes = specs.reduce((a, s) => a + s.sizeBytes, 0);
  const setCount = new Set(specs.map((s) => s.typeKey)).size;

  if (totalFiles === 0) {
    treeEl.replaceChildren();
    treeEl.hidden = true;
    emptyEl.hidden = false;
    emptyMsgEl.textContent =
      errs.sizes ? "Sizes below the format minimum."
      : !sizesValid ? { range: "Invalid size range.", list: "Invalid size list.", boundary: "Invalid boundary limits." }[state.mode]
      : "No file types selected.";
    manifestText = "";
    metaEl.replaceChildren();
  } else {
    treeEl.hidden = false;
    emptyEl.hidden = true;
    manifestText = renderTree(buildTree(specs, state.types, folderName));
    renderMeta(setCount, totalFiles, totalBytes);
  }

  // Warning
  if (totalBytes > WARN_TOTAL_BYTES) {
    warningEl.textContent = `Batch is ${fmtBytes(totalBytes)}. Above 500 MB, browser memory can become the bottleneck and the download may fail on Firefox or Safari. Chrome and Edge stream to disk and handle larger sizes.`;
    warningEl.hidden = false;
  } else {
    warningEl.hidden = true;
  }

  generateBtn.disabled = busy || totalFiles === 0;
  copyBtn.disabled = totalFiles === 0;

  // Clear stale status
  if (clearStatus && !busy) setStatus("");

  return specs;
}

function setStatus(msg, cls = "") {
  statusEl.textContent = msg;
  statusEl.classList.remove("ok", "err", "busy");
  if (cls) statusEl.classList.add(cls);
}

// ---------- Zip generation ----------

async function* fileStream(specs, folderName, onProgress) {
  let idx = 0;
  for (const spec of specs) {
    idx += 1;
    onProgress(idx, specs.length, spec);
    // Yield to event loop so status updates paint before CPU work
    await new Promise((r) => setTimeout(r, 0));
    const bytes = await TYPES[spec.typeKey].make(spec.sizeBytes);
    if (bytes.length !== spec.sizeBytes) {
      throw new Error(`${spec.name} came out at ${bytes.length} bytes, expected ${spec.sizeBytes}`);
    }
    yield {
      name: `${folderName}/${spec.dir}/${spec.name}`,
      input: bytes,
      lastModified: new Date(),
    };
  }
}

function markProgress(i) {
  // i is 1-based index of the file now being generated
  const prev = treeEl.querySelector(".ln.cur");
  if (prev) {
    prev.classList.remove("cur");
    prev.classList.add("done");
  }
  const cur = treeEl.querySelector(`.ln[data-i="${i - 1}"]`);
  if (cur) {
    cur.classList.add("cur");
    cur.scrollIntoView({ block: "nearest" });
  }
}

function finishProgress() {
  const prev = treeEl.querySelector(".ln.cur");
  if (prev) {
    prev.classList.remove("cur");
    prev.classList.add("done");
  }
}

async function generate(event) {
  event.preventDefault();
  if (busy) return;

  busy = true;
  const specs = render({ clearStatus: false }); // fresh tree, no stale progress marks
  if (specs.length === 0) {
    busy = false;
    render({ clearStatus: false });
    return;
  }

  const folderName = `DataWizard_${todayISO()}`;
  const zipName = `${folderName}.zip`;

  form.inert = true;
  generateBtn.disabled = true;
  generateBtn.classList.add("working");
  generateLabel.textContent = "Generating…";
  setStatus("Preparing…", "busy");

  const onProgress = (i, total, spec) => {
    setStatus(`[${i}/${total}] ${spec.dir}/${spec.name}`, "busy");
    markProgress(i);
  };

  let cancelled = false;
  try {
    // Prefer streaming direct-to-disk via File System Access API.
    const canSaveFile = "showSaveFilePicker" in window;

    if (canSaveFile) {
      let handle;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: zipName,
          types: [{ description: "Zip archive", accept: { "application/zip": [".zip"] } }],
        });
      } catch (e) {
        if (e && e.name === "AbortError") {
          cancelled = true;
          setStatus("Cancelled.");
          return;
        }
        throw e;
      }
      const writable = await handle.createWritable();
      const response = downloadZip(fileStream(specs, folderName, onProgress));
      await response.body.pipeTo(writable);
      finishProgress();
      setStatus(`Wrote ${zipName}.`, "ok");
    } else {
      // Fallback: buffer to a Blob, trigger anchor download.
      const response = downloadZip(fileStream(specs, folderName, onProgress));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      finishProgress();
      setStatus(`Downloaded ${zipName} (${fmtBytes(blob.size)}).`, "ok");
    }
  } catch (err) {
    console.error(err);
    setStatus(`Failed: ${err.message || err}`, "err");
  } finally {
    busy = false;
    form.inert = false;
    generateBtn.classList.remove("working");
    generateLabel.textContent = "Generate";
    // Refresh button state; keep the result message (and progress marks) visible.
    if (cancelled) render({ clearStatus: false });
    else generateBtn.disabled = false;
  }
}

// ---------- Copy ----------

async function copyManifest() {
  if (!manifestText) return;
  let ok = false;
  try {
    await navigator.clipboard.writeText(manifestText);
    ok = true;
  } catch {
    // Clipboard API blocked (file://, insecure context): fall back to execCommand
    const ta = document.createElement("textarea");
    ta.value = manifestText;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
  }
  copyLabel.textContent = ok ? "Copied" : "Copy failed";
  copyBtn.setAttribute("aria-label", ok ? "Copied" : "Copy failed");
  clearTimeout(copyManifest.t);
  copyManifest.t = setTimeout(() => {
    copyLabel.textContent = "Copy";
    copyBtn.setAttribute("aria-label", "Copy manifest");
  }, 1500);
}

// ---------- Numeric inputs and steppers ----------

function sanitize(input) {
  const digits = input.value.replace(/\D+/g, "");
  if (digits !== input.value) {
    const pos = input.selectionStart - (input.value.length - digits.length);
    input.value = digits;
    try { input.setSelectionRange(Math.max(pos, 0), Math.max(pos, 0)); } catch {}
  }
}

function bump(input, delta) {
  const cur = numOrNull(input.value) ?? 0;
  input.value = String(Math.max(1, cur + delta));
  render();
}

for (const input of [startEl, stepEl, maxEl, offsetEl]) {
  input.addEventListener("input", () => sanitize(input));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") { e.preventDefault(); bump(input, 1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); bump(input, -1); }
  });
}

form.addEventListener("click", (e) => {
  const btn = e.target.closest(".step-btn");
  if (!btn) return;
  bump(document.getElementById(btn.dataset.target), Number(btn.dataset.delta));
});

// ---------- Wire up ----------

form.addEventListener("input", () => render());
form.addEventListener("change", () => render());
form.addEventListener("submit", generate);
copyBtn.addEventListener("click", copyManifest);

render();
