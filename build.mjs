// Zero-dependency build: inlines src/ into one self-contained dist/index.html
// that runs from file:// on air-gapped machines.
// Usage: node build.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(root, "src", p), "utf8");

function fail(msg) {
  console.error(`build: ${msg}`);
  process.exit(1);
}

function replaceOnce(haystack, needle, replacement, what) {
  const i = haystack.indexOf(needle);
  if (i === -1) fail(`could not find ${what}`);
  if (haystack.indexOf(needle, i + needle.length) !== -1) fail(`${what} appears more than once`);
  return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
}

// ---- Module wrapping ----
// Each ES module becomes an IIFE returning its exports, so top-level names
// (client-zip is minified to single letters) cannot collide.

function wrapClientZip(code) {
  const m = code.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
  if (!m) fail("client-zip: export list not found at end of file");
  const pairs = m[1].split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [local, , exported] = s.split(/\s+/);
    return `${exported ?? local}: ${local}`;
  });
  const body = code.slice(0, m.index);
  if (/(^|[;}\s])export\s/.test(body)) fail("client-zip: unexpected extra export");
  return { body, returns: pairs.join(", ") };
}

function wrapPlainModule(code, name) {
  const names = [];
  const body = code.replace(
    /^export\s+((?:async\s+)?function\s*\*?\s*(\w+)|(?:const|let|class)\s+(\w+))/gm,
    (_all, decl, fnName, varName) => {
      names.push(fnName || varName);
      return decl;
    },
  );
  if (/^\s*export\b/m.test(body)) fail(`${name}: unsupported export form`);
  if (/^\s*import\b/m.test(body)) fail(`${name}: nested imports not supported`);
  return { body, returns: names.join(", ") };
}

const modules = {
  "./vendor/client-zip.js": { id: "__mod_clientZip", ...wrapClientZip(src("vendor/client-zip.js")) },
  "./generators.js": { id: "__mod_generators", ...wrapPlainModule(src("generators.js"), "generators.js") },
};

let app = src("app.js");
app = app.replace(
  /^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?[ \t]*$/gm,
  (_all, names, spec) => {
    const mod = modules[spec];
    if (!mod) fail(`app.js imports unknown module ${spec}`);
    mod.used = true;
    return `const {${names}} = ${mod.id};`;
  },
);
if (/^\s*import\b/m.test(app)) fail("app.js: unsupported import form");
for (const [spec, mod] of Object.entries(modules)) if (!mod.used) fail(`module ${spec} not imported`);

const license = src("vendor/client-zip.LICENSE.txt").trim().replace(/\*\//g, "* /");

let bundle = "";
bundle += `/*! client-zip 2.4.5 | MIT License | ${license.split("\n")[0]} */\n`;
for (const mod of Object.values(modules)) {
  bundle += `const ${mod.id} = (() => {\n${mod.body}\nreturn { ${mod.returns} };\n})();\n`;
}
bundle += `(() => {\n${app}\n})();\n`;
bundle = bundle.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");

// ---- HTML ----

let html = src("index.html");
html = replaceOnce(html, '<link rel="stylesheet" href="styles.css">', `<style>\n${src("styles.css")}</style>`, "stylesheet link");
const favicon = Buffer.from(src("favicon.svg")).toString("base64");
html = replaceOnce(html, 'href="favicon.svg"', `href="data:image/svg+xml;base64,${favicon}"`, "favicon link");
html = replaceOnce(html, '<script type="module" src="app.js"></script>', `<script type="module">\n${bundle}</script>`, "app script tag");

if (/\b(src|href)="(?!data:)[^"#]+"/.test(html)) fail("external reference left in output");

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "index.html"), html);
console.log(`build: dist/index.html (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
