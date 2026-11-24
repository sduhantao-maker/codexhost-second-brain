import type { DesktopDefine } from "../host/types.js";
import { startController } from "../ui/controller.js";
import { startFavorites } from "../ui/favorites/index.js";
import { startHover } from "../ui/hover/index.js";
import { createDesktopAdapter } from "./adapter.js";

declare const define: DesktopDefine;

define({
  activate(api) {
    const adapter = createDesktopAdapter(api);
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
  },
});
