// @ts-check
// The package codexhost installs (dist/<id>.zip): which files go in, and the zip itself.
// scripts/build.mjs packs it after building; test/package.test.ts packs it the same way and checks
// every file against the rules codexhost applies when it installs a package. Typed with JSDoc, so
// that the type check covers it without a declaration file (codexhost takes no `.d.mts` in a package).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";

const KiB = 1024;

/** A file of the package: its name in the zip, and its bytes. */
/** @typedef {[name: string, bytes: Buffer]} PackageFile */

/** The limits codexhost and the extension registry apply. */
export const LIMITS = {
  "manifest.json": 128 * KiB,
  script: 2048 * KiB,
  style: 256 * KiB,
  icon: 128 * KiB,
  screenshot: 512 * KiB,
  license: 64 * KiB,
};

/** The files scripts/build.mjs builds, in the order it builds them. */
export const BUILT = ["desktop.js", "web/index.mjs", "page/index.mjs", "backend/index.mjs", "bin/mainline.mjs"];

/**
 * The package's files, sorted by name; throws when one is over its limit. Every name is one codexhost
 * takes in a package (a known suffix, or LICENSE, NOTICE and a few more): it refuses the whole package
 * for one it does not, which is why the GPL's text is COPYING.txt.
 * @param {string} root
 * @param {{ icon?: string, screenshots?: readonly string[] }} manifest
 * @returns {Promise<PackageFile[]>}
 */
export async function packageFiles(root, manifest) {
  /** @type {PackageFile[]} */
  const files = [];
  /** @type {(file: string, limit: number) => Promise<Buffer>} */
  const add = async (file, limit) => {
    const bytes = await readFile(path.join(root, file));
    if (bytes.length > limit) throw new Error(`${file} is over ${limit / KiB} KiB`);
    files.push([file, bytes]);
    return bytes;
  };
  await add("manifest.json", LIMITS["manifest.json"]);
  for (const file of BUILT) await add(file, LIMITS.script);
  await add("page/style.css", LIMITS.style);
  /** @type {Array<[string, number]>} */
  const images = [...(manifest.icon ? [/** @type {[string, number]} */ ([manifest.icon, LIMITS.icon])] : []), ...(manifest.screenshots ?? []).map((name) => /** @type {[string, number]} */ ([name, LIMITS.screenshot]))];
  for (const [name, limit] of images) checkImage(name, await add(name, limit));
  // The license goes with the package: LGPL-3.0-only, like codexhost. The LGPL is a set of additions
  // to the GPL-3.0, which must come along with it.
  await add("LICENSE", LIMITS.license);
  await add("COPYING.txt", LIMITS.license);
  return files.sort(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * PNG, JPEG or WebP, with the suffix matching the contents, as the registry requires.
 * @param {string} name
 * @param {Buffer} bytes
 */
export function checkImage(name, bytes) {
  const suffix = (name.split(".").pop() ?? "").toLowerCase();
  const head = bytes.subarray(0, 12);
  const matches =
    suffix === "png"
      ? head.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
      : suffix === "jpg" || suffix === "jpeg"
        ? head.subarray(0, 3).toString("hex") === "ffd8ff"
        : suffix === "webp" && head.subarray(0, 4).toString() === "RIFF" && head.subarray(8, 12).toString() === "WEBP";
  if (!matches) throw new Error(`${name} must be a PNG, JPEG or WebP named after its type`);
}

/**
 * A stored (uncompressed) ZIP dated 2026-01-01, like codexhost's own seed packages: the same files
 * always give the same bytes.
 * @param {ReadonlyArray<readonly [string, Buffer]>} entries
 * @returns {Buffer}
 */
export function zip(entries) {
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  /** @type {Buffer[]} */
  const parts = [];
  /** @type {Buffer[]} */
  const directory = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const fileName = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(0o100644 * 0x10000, 38);
    central.writeUInt32LE(offset, 42);
    parts.push(local, fileName, data);
    directory.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDirectory, end]);
}
