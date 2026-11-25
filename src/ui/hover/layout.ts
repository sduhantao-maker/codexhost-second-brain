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
 * What of an open popover is drawn: the popover itself, or, when it has no box of its own, its first
 * fixed-position descendant that has one. Codex Desktop (as seen in 26.1120) opens its row preview as an
 * empty `popover="hint"` element whose content is a fixed-position child placed beside the row
 * with CSS anchor positioning; the child is what covers the card.
 */
function drawnPart(popover: Element): Element | null {
  const own = boxOf(popover);
  if (own.width > 0 && own.height > 0) return popover;
  const view = popover.ownerDocument.defaultView;
  for (const inner of popover.querySelectorAll("*")) {
    const box = boxOf(inner);
    if (box.width > 0 && box.height > 0 && view?.getComputedStyle(inner).position === "fixed") return inner;
  }
  return null;
}

/**
 * A preview the host shows beside the hovered row on its own: Codex Desktop opens a popover in the
 * top layer (drawn by the popover itself, or by a fixed-position child of an empty one),
 * codexhost Web adds a fixed-position child of body. Either starts at the row's (or the sidebar's)
 * right edge near the row. The card makes room for it instead of covering it or being covered by it.
 * What is returned is the drawn element, the one the pointer crosses.
 */
export function hostPopup(doc: Document, row: Box, sidebar: Box | null, skip: (element: Element) => boolean): Element | null {
  const edges = [row.right, ...(sidebar && sidebar.width > 0 ? [sidebar.right] : [])];
  const view = doc.defaultView;
  const popovers = openPopovers(doc);
  for (const candidate of [...popovers, ...(doc.body?.children ?? [])]) {
    if (skip(candidate)) continue;
    const element = popovers.includes(candidate) ? drawnPart(candidate) : candidate;
    if (!element) continue;
    const box = boxOf(element);
    if (box.width <= 0 || box.height <= 0 || box.width > POPUP_MAX_WIDTH) continue;
    if (!edges.some((edge) => Math.abs(box.left - edge) <= POPUP_EDGE)) continue;
    if (box.bottom < row.top - POPUP_REACH || box.top > row.bottom + POPUP_REACH) continue;
    if (!popovers.includes(candidate) && view?.getComputedStyle(element).position !== "fixed") continue;
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
 * The part of a row in sight: its box as far as the ancestors that clip their content (a scrolled
 * list, a group folded to no height) and the sidebar leave it on screen. Null when none of it is,
 * when it is not laid out (in a group hidden with `display: none`) or when it is invisible.
 */
export function inSight(row: Element, sidebar: Element | null): Box | null {
  let shown: Box | null = boxOf(row);
  if (shown.width <= 0 || shown.height <= 0) return null;
  const view = row.ownerDocument.defaultView;
  const own = view?.getComputedStyle(row);
  if (own?.visibility === "hidden" || own?.display === "none") return null;
  // Where the browser tells (display: none or content-visibility: hidden further up).
  if (typeof row.checkVisibility === "function" && !row.checkVisibility()) return null;
  // Up to the sidebar, which clips what scrolled away; the whole page when the row is elsewhere.
  const last = sidebar?.contains(row) ? sidebar : null;
  for (let node = row.parentElement; node && shown; node = node.parentElement) {
    const style = view?.getComputedStyle(node);
    if (style?.display === "none") return null;
    if (node === last || clips(style)) shown = intersection(shown, boxOf(node));
    if (node === last) break;
  }
  if (shown && sidebar && !last) {
    const area = boxOf(sidebar);
    if (area.width > 0 && area.height > 0) shown = intersection(shown, area);
  }
  return shown;
}

/**
 * Where the news badge goes: centered in the empty strip left of the row's icon, level with the
 * row's first line, so it covers neither the icon nor the title. Where that strip is too narrow,
 * on the icon's top-right corner. Null when the row is out of view: scrolled away, folded into a
 * collapsed group, hidden or not laid out.
 */
export function newsBadgeSpot(row: Element, sidebar: Element | null): { x: number; y: number } | null {
  const box = boxOf(row);
  if (box.width <= 0 || box.height <= 0) return null;
  const middle = box.top + Math.min(box.height, LINE_MAX) / 2;
  const area = sidebar ? boxOf(sidebar) : null;
  if (area && area.height > 0 && (middle < area.top || middle > area.bottom)) return null;
  const shown = inSight(row, sidebar);
  if (!shown || middle < shown.top || middle > shown.bottom) return null;
  const icon = leadingIcon(row, box);
  const iconLeft = icon?.left ?? box.left + 12;
  const from = Math.max(area && area.width > 0 ? area.left : Number.NEGATIVE_INFINITY, iconLeft - GUTTER_MAX);
  const to = iconLeft - GUTTER_PAD;
  if (to - from >= GUTTER_MIN) return { x: Math.round((from + to) / 2), y: Math.round(middle) };
  if (icon) return { x: Math.round(icon.right - 3), y: Math.round(icon.top + 2) };
  return { x: Math.round(box.left + 12), y: Math.round(middle) };
}

/** Controls a row may have of its own (pin, archive, a menu). */
const ROW_CONTROLS = "button, a[href], [role='button'], [role='link'], [role='menuitem'], [role='checkbox'], [role='switch']";
/** Fields, which are never the row itself. */
const FIELDS = "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox'], [role='searchbox']";

/**
 * Whether `target`, in `row`, is on one of the row's own small controls (pin, archive, a menu: a
 * control narrower than half the row) or in a field, rather than on the row itself or on a part
 * of it that opens the conversation.
 */
export function onRowControl(target: EventTarget | null, row: Element): boolean {
  const width = boxOf(row).width;
  for (let node = target instanceof Element ? target : null; node && node !== row; node = node.parentElement) {
    if (node.matches(FIELDS)) return true;
    if (node.matches(ROW_CONTROLS) && boxOf(node).width < width / 2) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The summary: one button at the top of the sidebar for news whose conversation has no row in
// sight (in a collapsed group, scrolled away, or not listed at all).

/**
 * What the summary keeps clear of, in viewport pixels. `hard`: the host's text, icons, small
 * controls and fields, never covered. `buttons`: buttons and links as wide as a row (a "New chat"
 * bar). `rows`: other things clicked as a whole (a conversation row, a group header). `scrolling`:
 * lists that scroll, whose content moves under anything placed over them.
 */
export interface HostContent {
  hard: Box[];
  buttons: Box[];
  rows: Box[];
  scrolling: Box[];
}

const BUTTONS = "button, a[href], [role='button'], [role='link']";
const CONTROLS = `${BUTTONS}, ${FIELDS}, summary, label, [role='menuitem'], [role='tab'], [role='treeitem'], [role='option'], [role='checkbox'], [role='radio'], [role='switch']`;
const PICTURES = "svg, img, canvas, video, [role='img']";
/** A control at least this share of the sidebar's width wide is a whole row or bar, not a small button. */
const WIDE_SHARE = 0.6;
/** The summary stays this far inside the sidebar, and this far from what it keeps clear of. */
const SUMMARY_PAD = 6;
const SUMMARY_GAP = 3;
/** How far down from the top of the sidebar the summary may go. */
export const SUMMARY_BAND = 160;
/** Its size where it cannot be measured (no layout). */
export const SUMMARY_SIZE = { width: 44, height: 20 } as const;
const SUMMARY_STEP = 2;

const overlap = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function intersection(a: Box, b: Box): Box | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
}

function clips(style: CSSStyleDeclaration | undefined): boolean {
  return Boolean(style) && [style!.overflow, style!.overflowX, style!.overflowY].some((value) => Boolean(value) && value !== "visible");
}

/** The boxes of an element's own text, where the browser can tell them; else the element's box. */
function textBoxes(element: Element, fallback: Box): Box[] {
  const boxes: Box[] = [];
  for (const node of element.childNodes) {
    if (node.nodeType !== 3 || !node.textContent?.trim()) continue;
    let box: Box | null = null;
    try {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    } catch {
      // No layout of text here.
    }
    boxes.push(box ?? fallback);
  }
  return boxes;
}

/**
 * The host's content within `area`, as far as it is on screen: what a clipping container shows
 * none of (rows scrolled away, a folded group) is left out, and so is what is not laid out or is
 * invisible. `skip` leaves out the extension's own overlays; `isRow` tells the host's
 * conversation rows. Only what lies in `area` is looked into, so a long page costs little.
 */
export function hostContent(doc: Document, area: Box, skip: (element: Element) => boolean, isRow: (element: Element) => boolean = () => false): HostContent {
  const view = doc.defaultView;
  const content: HostContent = { hard: [], buttons: [], rows: [], scrolling: [] };
  const wide = area.width * WIDE_SHARE;
  const visit = (parent: Element, clip: Box, parentCursor: string, depth: number) => {
    if (depth > 80) return;
    for (const element of parent.children) {
      if (skip(element)) continue;
      const rect = boxOf(element);
      if (rect.width <= 0 || rect.height <= 0) {
        // Not laid out, or only its children are (display: contents, or a box of no size around them).
        const style = view?.getComputedStyle(element);
        if (style?.display !== "none") visit(element, clips(style) ? (intersection(clip, rect) ?? clip) : clip, style?.cursor || parentCursor, depth + 1);
        continue;
      }
      const shown = intersection(rect, clip);
      if (!shown || !overlap(shown, area)) continue;
      const style = view?.getComputedStyle(element);
      const cursor = style?.cursor ?? "";
      const clipping = clips(style);
      const inner = clipping ? (intersection(clip, rect) ?? clip) : clip;
      if (style?.visibility === "hidden") {
        visit(element, inner, cursor, depth + 1);
        continue;
      }
      if (clipping && /auto|scroll|overlay/u.test(style?.overflowY ?? "") && element.scrollHeight - element.clientHeight > 1) content.scrolling.push(shown);
      if (element.matches(PICTURES)) {
        content.hard.push(shown);
        continue;
      }
      // Clickable: a control, a conversation row, or where a pointer cursor starts (not where it is only inherited).
      const clickable = element.matches(CONTROLS) || isRow(element) || (cursor === "pointer" && parentCursor !== "pointer");
      if (clickable && (shown.width < wide || element.matches(FIELDS))) {
        content.hard.push(shown);
        continue;
      }
      if (clickable) (element.matches(BUTTONS) ? content.buttons : content.rows).push(shown);
      for (const text of textBoxes(element, rect)) {
        const seen = intersection(text, clip);
        if (seen) content.hard.push(seen);
      }
      visit(element, inner, cursor, depth + 1);
    }
  };
  const root = doc.body ?? doc.documentElement;
  const width = view?.innerWidth || area.right;
  const height = view?.innerHeight || area.bottom;
  visit(root, { left: 0, top: 0, right: width, bottom: height, width, height }, view?.getComputedStyle(root).cursor ?? "", 0);
  return content;
}

/** The left edge of the rightmost gap at least `width` wide between `from` and `to` that none of `boxes` covers between `top` and `bottom`. */
function rightmostGap(boxes: readonly Box[], top: number, bottom: number, from: number, to: number, width: number): number | null {
  const taken = boxes
    .filter((box) => box.top < bottom && box.bottom > top)
    .map((box) => [box.left - SUMMARY_GAP, box.right + SUMMARY_GAP] as const)
    .sort((a, b) => b[1] - a[1]);
  // From the right: `end` is where the free stretch being looked at ends.
  let end = to;
  for (const [left, right] of taken) {
    if (right < end && end - Math.max(right, from) >= width) return end - width;
    end = Math.min(end, left);
    if (end - from < width) return null;
  }
  return end - from >= width ? end - width : null;
}

/**
 * Where the summary goes: at the top of the sidebar, on the first line down from its top edge (then
 * up the space above it, where a window's title bar may have room) with a free gap, as far right as
 * the gap allows; a line level with something of the host's (a header, a row of buttons) before
 * any other, so that it sits in line with them. First clear of everything in `content` and
 * `avoid`, lists that scroll included; failing that, it may sit over a list that scrolls (and moves
 * when it does), then on the empty end of a row or a group header, then of a wide button; when even
 * that is taken, in the sidebar's top right corner. `over`: whether it ended up over a list that
 * scrolls.
 */
export function summarySpot(
  sidebar: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  content: HostContent,
  avoid: readonly Box[] = [],
): { left: number; top: number; over: boolean } {
  const left = Math.max(sidebar.left, 0) + SUMMARY_PAD;
  const right = Math.min(sidebar.right, viewport.width) - SUMMARY_PAD;
  const top = Math.max(sidebar.top, 0);
  const bottom = Math.min(top + SUMMARY_BAND, sidebar.bottom, viewport.height - EDGE);
  const inBand = (y: number) => y >= top && y + size.height <= bottom;
  const aboveIt = (y: number) => y >= EDGE && y + size.height <= top;
  // Lines level with the middle of the host's things, from the top down, then up from the sidebar.
  const level = [...new Set([...content.hard, ...content.buttons, ...content.rows, ...avoid].map((box) => Math.round(box.top + box.height / 2 - size.height / 2)))];
  const lines: number[] = [...level.filter(inBand).sort((a, b) => a - b)];
  for (let y = top + SUMMARY_PAD; inBand(y); y += SUMMARY_STEP) lines.push(y);
  lines.push(...level.filter(aboveIt).sort((a, b) => b - a));
  for (let y = top - SUMMARY_PAD - size.height; y >= EDGE; y -= SUMMARY_STEP) lines.push(y);
  const find = (boxes: readonly Box[]) => {
    for (const y of lines) {
      const x = rightmostGap(boxes, y - SUMMARY_GAP, y + size.height + SUMMARY_GAP, left, right, size.width);
      if (x !== null) return { left: Math.round(x), top: Math.round(y) };
    }
    return null;
  };
  const hard = [...content.hard, ...avoid];
  const spot =
    find([...hard, ...content.buttons, ...content.rows, ...content.scrolling]) ??
    find([...hard, ...content.buttons, ...content.rows]) ??
    find([...hard, ...content.buttons]) ??
    find(hard) ?? { left: Math.round(Math.max(left, right - size.width)), top: Math.round(top + SUMMARY_PAD) };
  const box = { ...spot, right: spot.left + size.width, bottom: spot.top + size.height, width: size.width, height: size.height };
  return { ...spot, over: content.scrolling.some((list) => overlap(list, box)) };
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
