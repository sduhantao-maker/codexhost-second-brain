/**
 * Copies the `mainline` command into the data folder, whose path does not change between
 * extension updates, and writes small wrappers that start it with Node.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { commandPath, shellQuote } from "../node/paths.js";

async function writeIfChanged(file: string, content: string, mode: number): Promise<void> {
  const current = await readFile(file, "utf8").catch(() => undefined);
  if (current !== content) {
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, content, { mode });
    await rename(temporary, file);
  }
  await chmod(file, mode);
}

export function posixWrapper(nodePath: string): string {
  return [
    "#!/bin/sh",
    "# Written by the codexhost Second Brain extension: runs the mainline command with Node.",
    "# The Claude Code hook has nothing to do outside codexhost sessions, so skip starting Node.",
    'case "${1-}" in hook) [ -n "${CODEXHOST_THREAD_ID-}${CODEX_THREAD_ID-}" ] || exit 0 ;; esac',
    'dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    `node=${shellQuote(nodePath)}`,
    'if [ -x "$node" ]; then exec "$node" "$dir/mainline.mjs" "$@"; fi',
    'exec node "$dir/mainline.mjs" "$@"',
    "",
  ].join("\n");
}

export function windowsWrapper(nodePath: string): string {
  return [
    "@echo off",
    `if exist "${nodePath}" (`,
    `  "${nodePath}" "%~dp0mainline.mjs" %*`,
    ") else (",
    '  node "%~dp0mainline.mjs" %*',
    ")",
    "",
  ].join("\r\n");
}

/** Returns the path agents should run. */
export async function installCli(extensionDir: string, dataDir: string, nodePath: string): Promise<string> {
  const bin = path.join(dataDir, "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const script = await readFile(path.join(extensionDir, "bin", "mainline.mjs"), "utf8");
  await writeIfChanged(path.join(bin, "mainline.mjs"), script, 0o644);
  await writeIfChanged(path.join(bin, "mainline"), posixWrapper(nodePath), 0o755);
  await writeIfChanged(path.join(bin, "mainline.cmd"), windowsWrapper(nodePath), 0o644);
  return commandPath(dataDir);
}
