/**
 * A version 1 state file as releases 0.1 and 0.2 wrote it: one mainline ("开发主线插件") shared by
 * its main window and an unrelated window, with a done item, a parked item and a task in progress.
 */
import { readFileSync } from "node:fs";
import type { State } from "../../src/core/model.js";

export function v1StateText(): string {
  return readFileSync(new URL("./v1-state.json", import.meta.url), "utf8");
}

export function v1State(): State {
  return JSON.parse(v1StateText()) as State;
}
