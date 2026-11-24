/**
 * Finds the widest empty stretch of a header bar, so the capsule can sit in the header instead
 * of covering the conversation. Empty means no visible text, control or image above it.
 */

export interface Band {
  left: number;
  right: number;
  top: number;
  height: number;
}

const CONTROLS = "button, a, input, select, textarea, svg, img, canvas, video, [role='button'], [role='tab']";

export function freeBand(container: Element | null | undefined): Band | null {
  if (!container) return null;
  const bar = container.getBoundingClientRect();
  if (bar.width <= 0 || bar.height < 28) return null;
  const doc = container.ownerDocument;
  const spans: Array<[number, number]> = [];
  const add = (rect: DOMRect | undefined) => {
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    if (rect.bottom <= bar.top || rect.top >= bar.bottom) return;
    spans.push([Math.max(bar.left, rect.left), Math.min(bar.right, rect.right)]);
  };
  const view = doc.defaultView;
  const filter = view?.NodeFilter?.SHOW_TEXT ?? 4;
  const walker = doc.createTreeWalker(container, filter);
  const range = doc.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim() || typeof range.getBoundingClientRect !== "function") continue;
    range.selectNodeContents(node);
    // A truncated title lays out its whole text; only the part its box shows counts.
    const text = range.getBoundingClientRect();
    const clip = node.parentElement?.getBoundingClientRect();
    if (!clip) add(text);
    else {
      const left = Math.max(text.left, clip.left);
      const right = Math.min(text.right, clip.right);
      if (right > left) add({ ...text.toJSON?.(), left, right, width: right - left, top: text.top, bottom: text.bottom, height: text.height } as DOMRect);
    }
  }
  for (const element of container.querySelectorAll(CONTROLS)) add(element.getBoundingClientRect());
  spans.sort((a, b) => a[0] - b[0]);
  let best: [number, number] | null = null;
  let cursor = bar.left;
  const consider = (left: number, right: number) => {
    if (right - left > (best ? best[1] - best[0] : 0)) best = [left, right];
  };
  for (const [left, right] of spans) {
    if (left > cursor) consider(cursor, left);
    cursor = Math.max(cursor, right);
  }
  consider(cursor, bar.right);
  const found = best as [number, number] | null;
  return found ? { left: found[0], right: found[1], top: bar.top, height: bar.height } : null;
}
