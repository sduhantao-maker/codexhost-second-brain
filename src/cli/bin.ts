import { run, scriptPathOf } from "./main.js";

const readStdin = () =>
  new Promise<string>((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(text));
  });

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin,
  scriptPath: scriptPathOf(import.meta.url),
});
// stdin may still be open when the hook gives up waiting for it.
process.stdin.destroy();
