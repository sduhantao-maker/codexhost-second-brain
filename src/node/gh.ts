/**
 * Runs the user's own GitHub CLI (`gh`) with a minimal environment: the extension's backend
 * inherits none, and the command line should not depend on the caller's.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type RunGh = (args: string[]) => Promise<string>;

const CANDIDATES =
  process.platform === "win32"
    ? [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "GitHub CLI", "gh.exe")]
    : ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh"];

export function findGh(): string | undefined {
  return CANDIDATES.find((candidate) => existsSync(candidate));
}

/** Runs gh with a minimal environment: the backend itself inherits none. */
export function createGhRunner(executable: string | undefined = findGh(), timeoutMs = 20_000): RunGh {
  return (args) =>
    new Promise((resolve, reject) => {
      if (!executable) {
        reject(new Error("GitHub CLI (gh) was not found"));
        return;
      }
      const child = spawn(executable, args, {
        env: {
          HOME: os.homedir(),
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          NO_COLOR: "1",
          ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        windowsHide: true,
      });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(out) : reject(new Error((err.trim().split("\n")[0] || `gh exited with ${String(code)}`).slice(0, 200))),
      );
    });
}

