import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface Log {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

/** A log that can also say when what was written to it is on disk. */
export interface FileLog extends Log {
  /** Resolves once every line logged so far is written (or failed to be). */
  flush(): Promise<void>;
}

const MAX_BYTES = 256 * 1024;

/**
 * Makes text fit for the log and for bug reports: the home folder (with either kind of slash)
 * becomes `~`, and the user's name, wherever a path has it right after a slash, becomes `<user>`
 * (a name shorter than three characters is left: it would mangle ordinary paths).
 */
export function logSafe(home: string = os.homedir(), user: string | undefined = userName()): (text: string) => string {
  const homes = [...new Set([home, home.replace(/\\/gu, "/"), home.replace(/\//gu, "\\")])]
    .filter((value) => value.replace(/[\\/]/gu, "").length > 0)
    .sort((a, b) => b.length - a.length);
  const named = user && user.length >= 3 ? new RegExp(`([\\\\/])${user.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "gu") : undefined;
  return (text) => {
    let out = text;
    for (const value of homes) out = out.split(value).join("~");
    return named ? out.replace(named, "$1<user>") : out;
  };
}

function userName(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}

/**
 * The backend's stdout is discarded by codexhost, so diagnostics go to `backend.log`. Every line
 * goes through `logSafe`: no home folder and no user name in it.
 */
export function createLog(dir: string, options: { home?: string; user?: string } = {}): FileLog {
  const file = path.join(dir, "backend.log");
  const safe = logSafe(options.home, "user" in options ? options.user : userName());
  let queue = Promise.resolve();
  const write = (line: string) => {
    queue = queue
      .then(async () => {
        await mkdir(dir, { recursive: true });
        const size = await stat(file).then(
          (info) => info.size,
          () => 0,
        );
        if (size > MAX_BYTES) await rename(file, `${file}.1`).catch(() => undefined);
        await appendFile(file, `${new Date().toISOString()} ${safe(line)}\n`, { mode: 0o600 });
      })
      .catch(() => undefined);
  };
  return {
    info: (message) => write(message),
    error: (message, error) =>
      write(`ERROR ${message}${error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`}`),
    flush: () => queue,
  };
}
