/** Where the hover card and the row badge go, in viewport pixels. */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export const CARD_WIDTH = 320;
/** Space between the sidebar and the card. */
const GAP = 8;
/** Space kept from the window edges. */
const EDGE = 8;
/** Space between the badge and the row's own buttons. */
const BADGE_GAP = 6;
/** Rows whose buttons cannot be found: the badge keeps this far from the row's right edge. */
const BADGE_INSET = 10;
/** The row's own controls sit in its right part; whatever starts left of this share is its text. */
const RIGHT_SHARE = 0.45;
/**
 * A row taller than this probably wraps nested rows (a tree item with its children): the badge
 * then keeps to the row's first line.
 */
const LINE_MAX = 44;
const CONTROL = "button, a[href], input, select, [role='button'], [role='menuitem'], [role='checkbox'], [role='switch']";

export function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
}

/** A host popup wider than this is no row preview. */
const POPUP_MAX_WIDTH = 480;
/** How far from the row's or the sidebar's right edge a host popup may start. */
const POPUP_EDGE = 32;
/** How far above or below the row a host popup may reach and still belong to it. */
const POPUP_REACH = 160;
/** A host preview up to this tall gets the card stacked under (or over) it rather than beside it. */
const STACK_MAX_HEIGHT = 120;

/** Popovers open in the top layer, where Codex Desktop shows its row preview. */
function openPopovers(doc: Document): Element[] {
  try {
    return [...doc.querySelectorAll(":popover-open")];
  } catch {
    // No Popover API here.
    return [];
  }
}

/**
 * A preview the host shows beside the hovered row on its own: Codex Desktop opens a popover in the
 * top layer, codexhost Web adds a fixed-position child of body. Either starts at the row's (or the
 * sidebar's) right edge near the row. The card makes room for it instead of covering it or being
 * covered by it.
 */
export function hostPopup(doc: Document, row: Box, sidebar: Box | null, skip: (element: Element) => boolean): Element | null {
  const edges = [row.right, ...(sidebar && sidebar.width > 0 ? [sidebar.right] : [])];
  const view = doc.defaultView;
  const popovers = openPopovers(doc);
  for (const element of [...popovers, ...(doc.body?.children ?? [])]) {
    if (skip(element)) continue;
    const box = boxOf(element);
    if (box.width <= 0 || box.height <= 0 || box.width > POPUP_MAX_WIDTH) continue;
    if (!edges.some((edge) => Math.abs(box.left - edge) <= POPUP_EDGE)) continue;
    if (box.bottom < row.top - POPUP_REACH || box.top > row.bottom + POPUP_REACH) continue;
    if (!popovers.includes(element) && view?.getComputedStyle(element).position !== "fixed") continue;
    return element;
  }
  return null;
}

/**
 * Right of the sidebar with the top edge level with the row; moved up when it would run past the
 * bottom of the window, and to the sidebar's left (or the window's edge) when there is no room.
 * With a host preview beside the row, the card goes under a short preview (or over it, lined up
 * with it) and to the right of a tall one.
 */
export function cardSpot(
  row: Box,
  sidebar: Box | null,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  beside: Box | null = null,
): { left: number; top: number } {
  const side = sidebar && sidebar.width > 0 && sidebar.height > 0 ? sidebar : row;
  if (beside && beside.height <= STACK_MAX_HEIGHT) {
    const lined = Math.round(Math.max(EDGE, Math.min(beside.left, viewport.width - EDGE - size.width)));
    const below = beside.bottom + GAP;
    if (below + size.height <= viewport.height - EDGE) return { left: lined, top: Math.round(below) };
    const above = beside.top - GAP - size.height;
    if (above >= EDGE) return { left: lined, top: Math.round(above) };
  }
  let left = Math.max(side.right, beside?.right ?? Number.NEGATIVE_INFINITY) + GAP;
  if (left + size.width > viewport.width - EDGE) {
    const before = side.left - GAP - size.width;
    left = before >= EDGE ? before : Math.max(EDGE, viewport.width - EDGE - size.width);
  }
  const top = Math.max(EDGE, Math.min(row.top, viewport.height - EDGE - size.height));
  return { left: Math.round(left), top: Math.round(top) };
}

/** A top edge that keeps a card of this height inside the window. */
export function keepInside(top: number, height: number, viewport: { height: number }): number {
  return Math.round(Math.max(EDGE, Math.min(top, viewport.height - EDGE - height)));
}

/**
 * The left edge of the row's own controls (pin, archive, menus, a time label): visible
 * descendants that start in the row's right part. Null when there are none.
 */
export function controlsLeft(row: Element, box: Box = boxOf(row)): number | null {
  const view = row.ownerDocument.defaultView;
  const threshold = box.left + box.width * RIGHT_SHARE;
  let left = Number.POSITIVE_INFINITY;
  for (const element of row.querySelectorAll("*")) {
    const isSvg = element.namespaceURI === "http://www.w3.org/2000/svg";
    // Shapes inside an icon: the icon itself counts.
    if (isSvg && element.tagName.toLowerCase() !== "svg") continue;
    const control = element.matches(CONTROL);
    const leaf = element.childElementCount === 0;
    const text = leaf ? (element.textContent?.trim() ?? "") : "";
    // Short text only, such as a time label: a longer piece is part of the title (Codex Desktop
    // shows the end of a long title as a separate piece while the row is not hovered).
    if (!control && !isSvg && !(leaf && (element.tagName === "IMG" || (text && Array.from(text).length <= SHORT_TEXT)))) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.left < threshold || rect.width > box.width / 2) continue;
    if (rect.bottom <= box.top || rect.top >= box.bottom) continue;
    if (view?.getComputedStyle(element).visibility === "hidden") continue;
    left = Math.min(left, rect.left);
  }
  return Number.isFinite(left) ? left : null;
}

/** Text this short in a row's right part is a label (a time, a count), not part of the title. */
const SHORT_TEXT = 8;
/** An icon at the start of a row is about this size; bigger or smaller things are not it. */
const ICON_MIN = 8;
const ICON_MAX = 36;

/** The strip left of a row's icon used for the news badge: how far back it may reach, and how narrow it may be. */
const GUTTER_MAX = 40;
const GUTTER_MIN = 10;
const GUTTER_PAD = 4;

/** The row's leading icon: the first small icon in its first line's left part. */
export function leadingIcon(row: Element, box: Box = boxOf(row)): Box | null {
  const lineBottom = box.top + Math.min(box.height, LINE_MAX);
  const view = row.ownerDocument.defaultView;
  for (const element of row.querySelectorAll("svg, img, [role='img']")) {
    if (element.parentElement?.closest("svg")) continue;
    const rect = boxOf(element);
    if (rect.width < ICON_MIN || rect.height < ICON_MIN || rect.width > ICON_MAX || rect.height > ICON_MAX) continue;
    if (rect.left > box.left + box.width * 0.3 || rect.bottom <= box.top || rect.top >= lineBottom) continue;
    if (view?.getComputedStyle(element).visibility === "hidden") continue;
    return rect;
  }
  return null;
}

/**
 * Where the news badge goes: centered in the empty strip left of the row's icon, level with the
 * row's first line, so it covers neither the icon nor the title. Where that strip is too narrow,
 * on the icon's top-right corner. Null when the row is out of view.
 */
export function newsBadgeSpot(row: Element, sidebar: Element | null): { x: number; y: number } | null {
  const box = boxOf(row);
  if (box.width <= 0 || box.height <= 0) return null;
  const middle = box.top + Math.min(box.height, LINE_MAX) / 2;
  const area = sidebar ? boxOf(sidebar) : null;
  if (area && area.height > 0 && (middle < area.top || middle > area.bottom)) return null;
  const icon = leadingIcon(row, box);
  const iconLeft = icon?.left ?? box.left + 12;
  const from = Math.max(area && area.width > 0 ? area.left : Number.NEGATIVE_INFINITY, iconLeft - GUTTER_MAX);
  const to = iconLeft - GUTTER_PAD;
  if (to - from >= GUTTER_MIN) return { x: Math.round((from + to) / 2), y: Math.round(middle) };
  if (icon) return { x: Math.round(icon.right - 3), y: Math.round(icon.top + 2) };
  return { x: Math.round(box.left + 12), y: Math.round(middle) };
}

/**
 * The badge's right edge and vertical center: just left of the row's own buttons, or near the
 * row's right end when it has none. Null when the row is not laid out or is scrolled out of view.
 */
export function badgeSpot(row: Element, sidebar: Element | null): { x: number; y: number } | null {
  const full = boxOf(row);
  if (full.width <= 0 || full.height <= 0) return null;
  const height = Math.min(full.height, LINE_MAX);
  const box = { ...full, height, bottom: full.top + height };
  const y = box.top + height / 2;
  if (sidebar) {
    const area = boxOf(sidebar);
    if (area.height > 0 && (y < area.top || y > area.bottom)) return null;
  }
  const controls = controlsLeft(row, box);
  const x = controls === null ? box.right - BADGE_INSET : controls - BADGE_GAP;
  return { x: Math.round(x), y: Math.round(y) };
}
