// @ts-check
// Draws the README images (docs/images/*.png) from the extension's real UI code: bundles
// scripts/screenshots/harness.ts with esbuild, writes one self-contained page per scene to a
// temporary folder, and photographs it in headless Chrome through the DevTools protocol (device
// scale factor 2). The diagrams are hand-written SVGs in docs/images, photographed the same way.
// Every page is made up of demo data (scripts/screenshots/demo.ts); nothing is read from codexhost.
//
//   npm run screenshots              all images
//   npm run screenshots -- hover     only those whose name contains "hover"
//
// Needs Google Chrome; set CHROME to its executable when it is not in the usual place.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { decode, optimize } from "./png.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const here = path.join(root, "scripts", "screenshots");
const out = path.join(root, "docs", "images");

/** The moment the demo data is relative to: 24 November 2026, 15:30 in Shanghai. */
const NOW = Date.parse("2026-11-24T15:30:00+08:00");
const TIMEZONE = "Asia/Shanghai";
const WIDTH = 880;
const SCALE = 2;

const CHROME_PATHS = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

/** @typedef {{ scene: "hover" | "save" | "overview", locale: "zh-CN" | "en", scheme: "light" | "dark", tab?: "conversations" | "favorites" | "refs" }} Scene */
/** @type {Array<{ name: string } & Scene>} */
const SCENES = [];
for (const [suffix, locale] of /** @type {const} */ ([["zh", "zh-CN"], ["en", "en"]])) {
  SCENES.push(
    { name: `hover-${suffix}`, scene: "hover", locale, scheme: "light" },
    { name: `hover-dark-${suffix}`, scene: "hover", locale, scheme: "dark" },
    { name: `overview-${suffix}`, scene: "overview", locale, scheme: "light", tab: "conversations" },
    { name: `save-${suffix}`, scene: "save", locale, scheme: "light" },
    { name: `favorites-${suffix}`, scene: "overview", locale, scheme: "light", tab: "favorites" },
    { name: `prs-${suffix}`, scene: "overview", locale, scheme: "light", tab: "refs" },
  );
}
const DIAGRAMS = ["how-it-works-zh", "how-it-works-en"];

const only = process.argv.slice(2);
const wanted = (/** @type {string} */ name) => !only.length || only.some((part) => name.includes(part));

// ---------------------------------------------------------------------------------------------
// The pages

const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["scripts/screenshots/harness.ts"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  tsconfigRaw: {},
  define: {
    __MAINLINE_CSS__: JSON.stringify(await readFile(path.join(root, "src", "ui", "styles.css"), "utf8")),
    __VERSION__: JSON.stringify(manifest.version),
  },
  logLevel: "warning",
});
const [output] = bundle.outputFiles;
if (!output) throw new Error("esbuild wrote nothing for the harness");
const script = output.text;
const icon = `data:image/png;base64,${(await readFile(path.join(root, manifest.icon))).toString("base64")}`;
const css = (await readFile(path.join(root, "src", "page", "style.css"), "utf8")) + "\n" + (await readFile(path.join(here, "harness.css"), "utf8"));

/** Date.now() and new Date() stand still at NOW, so "6 min ago" and "Today" never drift. */
const frozenClock = `(() => {
  const Real = Date;
  const fixed = ${NOW};
  function FixedDate(...args) {
    if (!new.target) return new Real(fixed).toString();
    return args.length ? new Real(...args) : new Real(fixed);
  }
  FixedDate.prototype = Real.prototype;
  FixedDate.now = () => fixed;
  FixedDate.parse = Real.parse;
  FixedDate.UTC = Real.UTC;
  globalThis.Date = FixedDate;
})();`;

/** @param {Scene} scene */
const page = (scene) =>
  `<!doctype html><html lang="${scene.locale}"><head><meta charset="utf-8"><style>${css}</style>` +
  `<script>${frozenClock}\nwindow.__SCENE__ = ${JSON.stringify({ ...scene, now: NOW, icon })};</script></head>` +
  `<body><script>${script.replace(/<\/script/giu, "<\\/script")}</script></body></html>`;

// ---------------------------------------------------------------------------------------------
// Chrome through the DevTools protocol

/** @returns {string} */
function chromePath() {
  const found = CHROME_PATHS.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error("Google Chrome was not found; set CHROME to its executable");
  return /** @type {string} */ (found);
}

/** @param {string} profile */
async function launch(profile) {
  const chrome = spawn(
    chromePath(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-domain-reliability",
      "--no-pings",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const url = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${text}`)), 20_000);
    chrome.stderr.on("data", (data) => {
      text += String(data);
      const match = /DevTools listening on (ws:\/\/\S+)/u.exec(text);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chrome.on("exit", (code) => reject(new Error(`Chrome exited (${code}):\n${text}`)));
  });
  return { chrome, url: /** @type {string} */ (url) };
}

class DevTools {
  /** @param {string} url */
  constructor(url) {
    this.socket = new WebSocket(url);
    this.next = 1;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
    this.pending = new Map();
    /** @type {Set<(message: any) => void>} */
    this.listeners = new Set();
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const waiting = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiting?.reject(new Error(`${message.error.message} (${message.error.code})`));
        else waiting?.resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    });
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("Could not reach Chrome's DevTools")), { once: true });
    });
  }

  /** @param {string} method @param {object} [params] @param {string} [sessionId] @returns {Promise<any>} */
  send(method, params = {}, sessionId) {
    const id = this.next++;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** @param {string} method @param {string} sessionId @param {number} ms */
  once(method, sessionId, ms = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`No ${method} within ${ms} ms`));
      }, ms);
      /** @param {any} message */
      const listener = (message) => {
        if (message.method !== method || message.sessionId !== sessionId) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message.params);
      };
      this.listeners.add(listener);
    });
  }
}

/**
 * Opens a tab of `width` CSS pixels at device scale factor 2 and loads `url` in it.
 * @param {DevTools} devtools @param {string} url @param {{ width: number, height: number, scheme: "light" | "dark" }} view
 */
async function open(devtools, url, view) {
  const { targetId } = await devtools.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await devtools.send("Target.attachToTarget", { targetId, flatten: true });
  /** @type {(method: string, params?: object) => Promise<any>} */
  const send = (method, params) => devtools.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: view.width, height: view.height, deviceScaleFactor: SCALE, mobile: false });
  await send("Emulation.setTimezoneOverride", { timezoneId: TIMEZONE });
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-color-scheme", value: view.scheme },
    ],
  });
  const loaded = devtools.once("Page.loadEventFired", sessionId);
  await send("Page.navigate", { url });
  await loaded;
  /** @param {string} expression @returns {Promise<any>} */
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  };
  return { send, evaluate, close: () => devtools.send("Target.closeTarget", { targetId }) };
}

/** @param {{ send: (method: string, params?: object) => Promise<any> }} tab @param {{ x: number, y: number, width: number, height: number }} rect */
async function capture(tab, rect) {
  const { data } = await tab.send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 }, captureBeyondViewport: false, fromSurface: true });
  return optimize(Buffer.from(data, "base64"));
}

// ---------------------------------------------------------------------------------------------

const temp = await mkdtemp(path.join(os.tmpdir(), "second-brain-screenshots-"));
const { chrome, url } = await launch(path.join(temp, "profile"));
const devtools = new DevTools(url);
/** @type {Array<{ file: string, bytes: number, width: number, height: number }>} */
const written = [];
try {
  await devtools.opened;
  await mkdir(out, { recursive: true });
  for (const scene of SCENES.filter((item) => wanted(item.name))) {
    const { name, ...setup } = scene;
    const file = path.join(temp, `${name}.html`);
    await writeFile(file, page(setup));
    const tab = await open(devtools, pathToFileURL(file).href, { width: WIDTH, height: 1400, scheme: setup.scheme });
    try {
      const started = Date.now();
      let state;
      while ((state = await tab.evaluate("window.__state")) === undefined && Date.now() - started < 15_000) await new Promise((resolve) => setTimeout(resolve, 50));
      if (state !== "ready") throw new Error(`${name}: ${(await tab.evaluate("window.__error")) ?? "the scene did not get ready"}`);
      if (setup.scene === "hover") {
        const target = await tab.evaluate("window.__target()");
        // From the window's edge onto the row, as a pointer would come.
        await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: target.y });
        await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x - 30, y: target.y });
        await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y });
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      const rect = await tab.evaluate("window.__finish()");
      const png = await capture(tab, rect);
      const target = path.join(out, `${name}.png`);
      await writeFile(target, png);
      const { width, height } = decode(png);
      written.push({ file: target, bytes: png.length, width, height });
    } finally {
      await tab.close();
    }
  }
  for (const name of DIAGRAMS.filter(wanted)) {
    const source = path.join(out, `${name}.svg`);
    const svg = await readFile(source, "utf8");
    const width = Number(/<svg[^>]*\bwidth="(\d+)"/u.exec(svg)?.[1]);
    const height = Number(/<svg[^>]*\bheight="(\d+)"/u.exec(svg)?.[1]);
    if (!width || !height) throw new Error(`${name}.svg needs a width and a height`);
    const file = path.join(temp, `${name}.html`);
    await writeFile(file, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`);
    const tab = await open(devtools, pathToFileURL(file).href, { width, height, scheme: "light" });
    try {
      await tab.evaluate("document.fonts.ready.then(() => true)");
      const png = await capture(tab, { x: 0, y: 0, width, height });
      const target = path.join(out, `${name}.png`);
      await writeFile(target, png);
      written.push({ file: target, bytes: png.length, width: width * SCALE, height: height * SCALE });
    } finally {
      await tab.close();
    }
  }
} finally {
  devtools.socket.close();
  const exited = new Promise((resolve) => {
    chrome.once("exit", resolve);
    setTimeout(resolve, 5000);
  });
  chrome.kill();
  await exited;
  await rm(temp, { recursive: true, force: true });
}
for (const { file, bytes, width, height } of written)
  console.log(`${path.relative(root, file)}  ${width}×${height}  ${(bytes / 1024).toFixed(0)} KB`);
