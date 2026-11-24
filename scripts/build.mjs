// Builds every entry the manifest declares and writes them next to manifest.json. With --zip it
// also packs the package codexhost installs, dist/<id>.zip (dist/second-brain.zip), with the license
// texts (scripts/package.mjs says what goes in); the same files always give the same bytes.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { build } from "esbuild";
import { BUILT, LIMITS, packageFiles, zip } from "./package.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const KiB = 1024;

const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const bilingual = (text) => Boolean(text?.en?.trim() && text["zh-CN"]?.trim());
if (manifest.manifestVersion !== 2) throw new Error("manifest.json must use manifestVersion 2");
if (!manifest.author?.trim() || !bilingual(manifest.name) || !bilingual(manifest.description))
  throw new Error("The registry needs an author and an English and Chinese name and description");
const expected = {
  "desktop.script": "desktop.js",
  "web.entry": "web/index.mjs",
  "page.entry": "page/index.mjs",
  "page.style": "page/style.css",
  "backend.entry": "backend/index.mjs",
};
for (const [key, file] of Object.entries(expected)) {
  const [entry, field] = key.split(".");
  if (manifest[entry]?.[field] !== file) throw new Error(`manifest.json must declare ${key} = ${file}`);
}
if ((manifest.screenshots ?? []).length > 4) throw new Error("At most 4 screenshots");

const css = await readFile(path.join(root, "src", "ui", "styles.css"), "utf8");
const define = {
  __MAINLINE_CSS__: JSON.stringify(css),
  __VERSION__: JSON.stringify(manifest.version),
};
const common = {
  absWorkingDir: root,
  bundle: true,
  write: false,
  legalComments: "inline",
  // tsconfig.json is for type checking; bundle without its options.
  tsconfigRaw: {},
  define,
  logLevel: "warning",
};
const browser = { ...common, platform: "browser", target: "es2022" };
const node = { ...common, platform: "node", target: "node22", format: "esm" };

const targets = [
  ["desktop.js", { ...browser, entryPoints: ["src/desktop/entry.ts"], format: "iife" }, "classic"],
  ["web/index.mjs", { ...browser, entryPoints: ["src/web/entry.ts"], format: "esm" }, "module"],
  ["page/index.mjs", { ...browser, entryPoints: ["src/page/index.ts"], format: "esm" }, "module"],
  ["backend/index.mjs", { ...node, entryPoints: ["src/backend/index.ts"] }, "node"],
  ["bin/mainline.mjs", { ...node, entryPoints: ["src/cli/bin.ts"], banner: { js: "#!/usr/bin/env node" } }, "node"],
];
if (targets.map(([file]) => file).join() !== BUILT.join()) throw new Error("scripts/package.mjs (BUILT) must list the files built here");

for (const [file, options, kind] of targets) {
  const { outputFiles } = await build(options);
  const [output] = outputFiles;
  const text = output.text;
  if (output.contents.length > LIMITS.script) throw new Error(`${file} is over ${LIMITS.script / KiB} KiB`);
  if (kind === "classic") {
    // Desktop loads the script as the body of a strict function.
    new Script(`(function (define) {"use strict";\n${text}\n})`);
  } else if (kind === "module") {
    // codexhost links page and web modules itself: no imports, no dynamic import().
    if (/^\s*import[\s{*"']/mu.test(text) || /\bimport\s*\(/u.test(text))
      throw new Error(`${file} must be a single self-contained module`);
  } else {
    for (const [, specifier] of text.matchAll(/\bfrom\s*["']([^"']+)["']/gu))
      if (!specifier.startsWith("node:")) throw new Error(`${file} imports ${specifier}; only node: builtins may stay external`);
  }
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), output.contents);
}
await copyFile(path.join(root, "src", "page", "style.css"), path.join(root, "page", "style.css"));

// Packed (and checked: sizes, images) also without --zip, so a plain build finds what would not pack.
const files = await packageFiles(root, manifest);
if (process.argv.includes("--zip")) {
  const output = path.join(root, "dist", `${manifest.id}.zip`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, zip(files));
  console.log(path.relative(root, output));
}
