/**
 * What codexhost installs, checked against the rules codexhost itself applies when it installs a
 * package: dist/second-brain.zip, and the repository as it stands (codexhost installs a GitHub
 * source archive of a branch too, and the extension registry falls back to one when a release has
 * no zip). codexhost 0.25.1 refused 0.10.0's first package with only "Host extension operation
 * failed": the GPL text went in as COPYING, a file name codexhost does not take. The rules below are
 * copied from codexhost 0.25.1 (host-runtime.mjs: packageLimit and indexHostPackage of
 * harness-plugin-files/dist/host-extension-package.js, readExtensionZip, and the resource paths and
 * limits of shared-contracts); a file codexhost would refuse fails here instead of in an install.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packageFiles, zip } from "../scripts/package.mjs";

const KiB = 1024;
const MiB = 1024 * KiB;

// ---------------------------------------------------------------------------------------------
// codexhost 0.25.1, as it is

const DESKTOP_EXTENSION_ZIP_MAX_BYTES = 64 * MiB;
const DESKTOP_EXTENSION_MANIFEST_MAX_BYTES = 128 * KiB;
const DESKTOP_EXTENSION_SCRIPT_MAX_BYTES = 2 * MiB;
const DESKTOP_EXTENSION_STYLE_MAX_BYTES = 256 * KiB;
const DESKTOP_EXTENSION_ASSET_MAX_BYTES = 16 * MiB;
const PACKAGE_INDEX = ".host-extension-generation.json";
const MAX_PACKAGE_BYTES = 256 * MiB;
const MAX_ENTRIES = 1e4;
const allowedSuffix = /\.(?:js|mjs|cjs|css|json|png|jpe?g|webp|gif|woff2|md|txt|svg|ts|tsx|ya?ml)$/iu;
const reservedName = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu;
const hostExtensionCanonicalPath = (resource: string) => resource.normalize("NFC").toLowerCase();

/** What one file of a package may weigh; throws "Unsupported extension package file" for a name codexhost does not take. */
function packageLimit(resource: string): number {
  if (hostExtensionCanonicalPath(resource) === PACKAGE_INDEX || !(allowedSuffix.test(resource) || /^(?:licen[cs]e|notice|\.gitignore|\.gitattributes)$/iu.test(path.posix.basename(resource))))
    throw new Error(`Unsupported extension package file: ${resource}`);
  if (resource === "manifest.json") return DESKTOP_EXTENSION_MANIFEST_MAX_BYTES;
  if (/\.[cm]?js$/iu.test(resource)) return DESKTOP_EXTENSION_SCRIPT_MAX_BYTES;
  if (/\.css$/iu.test(resource)) return DESKTOP_EXTENSION_STYLE_MAX_BYTES;
  return DESKTOP_EXTENSION_ASSET_MAX_BYTES;
}

/** Whether codexhost takes a file of this name in a package at all. */
function takes(resource: string): boolean {
  try {
    packageLimit(resource);
    return true;
  } catch {
    return false;
  }
}

/** pluginRelativeResourceSchema and hostExtensionResourcePathSchema: a portable relative path. */
function portablePath(resource: string): boolean {
  return (
    resource.length >= 1 &&
    resource.length <= 512 &&
    !/[\\\u0000:#?]/u.test(resource) &&
    !resource.startsWith("/") &&
    !resource.split("/").some((part) => part === ".." || part === "") &&
    !/[\x00-\x1f\x7f<>"|*]/u.test(resource) &&
    resource.split("/").every((part) => !/[. ]$/u.test(part) && !reservedName.test(part)) &&
    resource.split("/").length <= 32
  );
}

/** indexHostPackage, after readExtensionZip: every check codexhost makes of a package's files before it reads the manifest. */
function installable(zipBytes: Buffer, files: ReadonlyMap<string, Buffer>): void {
  if (zipBytes.length > DESKTOP_EXTENSION_ZIP_MAX_BYTES) throw new Error("Extension ZIP exceeds size limit");
  if (files.size > MAX_ENTRIES) throw new Error("Too many extension package files");
  const canonical = new Set<string>();
  let total = 0;
  for (const [resource, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (bytes.length > DESKTOP_EXTENSION_ASSET_MAX_BYTES) throw new Error("entry exceeds the size limit");
    if (!portablePath(resource)) throw new Error(`Expected a portable relative resource path: ${resource}`);
    const key = hostExtensionCanonicalPath(resource);
    if (canonical.has(key)) throw new Error(`Conflicting extension package paths at ${resource}`);
    canonical.add(key);
    total += bytes.length;
    if (bytes.length > packageLimit(resource) || total > MAX_PACKAGE_BYTES) throw new Error(`Extension package size limit exceeded: ${resource}`);
  }
}

// ---------------------------------------------------------------------------------------------

/** The files of a stored ZIP, as written by scripts/package.mjs, with their sizes and CRCs checked. */
function unzip(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("no end of central directory");
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = bytes.readUInt16LE(at + 10);
    const crc = bytes.readUInt32LE(at + 16);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const offset = bytes.readUInt32LE(at + 42);
    const name = bytes.toString("utf8", at + 46, at + 46 + nameLength);
    if (method !== 0) throw new Error(`${name} is not stored`);
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const data = bytes.subarray(start, start + size);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC mismatch`);
    files.set(name, data);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** What these tests read of manifest.json. */
interface Manifest {
  id: string;
  icon: string;
  screenshots?: string[];
  desktop: { script: string };
  web: { entry: string };
  page: { entry: string; style: string };
  backend: { entry: string };
}

const root = path.resolve(import.meta.dirname, "..");
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "second-brain-package-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the package codexhost installs", () => {
  it("holds only files codexhost takes, each within codexhost's limits", async () => {
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as Manifest;
    // Packed as `npm run package` packs it, into a folder of its own.
    const output = path.join(dir, `${manifest.id}.zip`);
    await writeFile(output, zip(await packageFiles(root, manifest)));
    const bytes = await readFile(output);
    const files = unzip(bytes);

    // codexhost's checks first: a refused file is named in the failure.
    expect(() => installable(bytes, files)).not.toThrow();
    expect([...files.keys()]).toEqual([
      "COPYING.txt",
      "LICENSE",
      "assets/icon.png",
      "backend/index.mjs",
      "bin/mainline.mjs",
      "desktop.js",
      "manifest.json",
      "page/index.mjs",
      "page/style.css",
      "web/index.mjs",
    ]);
    for (const [name, data] of files) expect(data.length, name).toBeLessThanOrEqual(packageLimit(name));
    // Every file the manifest names is there.
    for (const file of [manifest.desktop.script, manifest.web.entry, manifest.page.entry, manifest.page.style, manifest.backend.entry, manifest.icon]) expect(files.has(file), file).toBe(true);
    // The GPL's text goes along, under a name codexhost takes, exactly as the repository keeps it.
    expect(files.get("COPYING.txt")!.equals(await readFile(path.join(root, "COPYING.txt")))).toBe(true);
    expect(files.get("COPYING.txt")!.toString("utf8", 0, 80)).toContain("GNU GENERAL PUBLIC LICENSE");
  });

  it("is the repository itself too: every file git tracks is one codexhost takes", async (context) => {
    let listed: string;
    try {
      listed = (await promisify(execFile)("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 16 * MiB })).stdout;
    } catch (error) {
      // Without git (or outside a clone) there is no list of tracked files to check.
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT" || /not a git repository/iu.test(String((error as { stderr?: unknown }).stderr ?? ""));
      if (!missing) throw error;
      context.skip();
      return;
    }
    const tracked = listed.split("\0").filter(Boolean);
    expect(tracked).toContain("manifest.json");
    // Each name as codexhost judges it: the refused ones all at once.
    expect(tracked.filter((name) => !takes(name))).toEqual([]);
    // And the whole repository as one package: sizes, paths, totals.
    const files = new Map<string, Buffer>();
    for (const name of tracked) files.set(name, await readFile(path.join(root, name)));
    expect(() => installable(Buffer.alloc(0), files)).not.toThrow();
  });

  it("would fail on a file name codexhost does not take, as 0.10.0's first package did", () => {
    for (const name of ["COPYING", "README", "bin/mainline", "scripts/release.sh", "scripts/package.d.mts", PACKAGE_INDEX, "assets/ICON.PNG.bak"])
      expect(() => packageLimit(name), name).toThrow(`Unsupported extension package file: ${name}`);
    for (const name of ["LICENSE", "licence", "NOTICE", ".gitignore", "COPYING.txt", "CHANGELOG.md", "assets/icon.png", "fonts/a.woff2", "data/rules.yaml"])
      expect(() => packageLimit(name), name).not.toThrow();
    expect([packageLimit("manifest.json"), packageLimit("desktop.js"), packageLimit("bin/mainline.mjs"), packageLimit("page/style.css"), packageLimit("COPYING.txt")]).toEqual([
      128 * KiB,
      2 * MiB,
      2 * MiB,
      256 * KiB,
      16 * MiB,
    ]);
    const one = (name: string, size = 1) => new Map([[name, Buffer.alloc(size)]]);
    expect(() => installable(Buffer.alloc(1), one("COPYING"))).toThrow("Unsupported extension package file: COPYING");
    expect(() => installable(Buffer.alloc(1), one("page/style.css", 256 * KiB + 1))).toThrow("Extension package size limit exceeded: page/style.css");
    expect(() => installable(Buffer.alloc(1), one("assets/aux.png"))).toThrow("portable relative resource path");
    expect(() => installable(Buffer.alloc(1), new Map([["A.txt", Buffer.alloc(1)], ["a.txt", Buffer.alloc(1)]]))).toThrow("Conflicting extension package paths");
  });
});
