import os from "node:os";
import path from "node:path";

/**
 * The extension's id in codexhost, which names its data folder. Before 0.10 the extension was
 * "mainline" (主线任务); its data is copied over once (backend/migrate-from-mainline.ts). The
 * command agents run is still called `mainline`.
 */
export const EXTENSION_ID = "second-brain";

/** Data directory codexhost gives this extension: `$CODEXHOST_DATA_DIR/host-extension-data/second-brain`. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.CODEXHOST_DATA_DIR?.trim() || path.join(os.homedir(), ".codexhost");
  return path.join(root, "host-extension-data", EXTENSION_ID);
}

/** True when `dir` looks like a codexhost extension data directory for the extension `id` (this one by default). */
export function isExtensionDataDir(dir: string, id: string = EXTENSION_ID): boolean {
  return path.basename(dir) === id && path.basename(path.dirname(dir)) === "host-extension-data";
}

/** The command agents run, as installed by the backend. */
export function commandPath(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(dataDir, "bin", platform === "win32" ? "mainline.cmd" : "mainline");
}

/** Quotes a path for a POSIX shell command line. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;
}
