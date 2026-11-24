import type { WebApi } from "../host/types.js";
import { startController } from "../ui/controller.js";
import { startFavorites } from "../ui/favorites/index.js";
import { startHover } from "../ui/hover/index.js";
import { createWebAdapter } from "./adapter.js";

export function activate(api: WebApi) {
  const adapter = createWebAdapter(api);
  const controller = startController(adapter);
  // Sidebar hover card (hover workstream).
  const stopHover = startHover(adapter, controller);
  // Saving selected text, and showing a saved passage again.
  const stopFavorites = startFavorites(adapter, controller);
  return () => {
    stopFavorites();
    stopHover();
    controller.dispose();
  };
}
