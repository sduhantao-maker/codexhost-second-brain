/** Light or dark, read from the host page itself so the capsule matches whatever theme it uses. */

export type Scheme = "light" | "dark";

function parseColor(value: string): [number, number, number, number] | undefined {
  const match = /rgba?\(([^)]+)\)/u.exec(value);
  if (!match?.[1]) return undefined;
  const parts = match[1].split(/[\s,/]+/u).filter(Boolean).map(Number);
  const [r = 0, g = 0, b = 0, a = 1] = parts;
  return [r, g, b, a];
}

function luminance([r, g, b]: [number, number, number, number]): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function detectScheme(doc: Document, probe?: Element | null): Scheme {
  const view = doc.defaultView;
  const candidates = [probe, doc.body, doc.documentElement].filter((node): node is Element => Boolean(node));
  for (const node of candidates) {
    const color = parseColor(view?.getComputedStyle(node).backgroundColor ?? "");
    if (color && color[3] > 0.5) return luminance(color) < 0.4 ? "dark" : "light";
  }
  const root = doc.documentElement;
  const hint = `${root.className} ${root.getAttribute("data-theme") ?? ""} ${root.style.colorScheme}`;
  if (/\bdark\b/u.test(hint)) return "dark";
  if (/\blight\b/u.test(hint)) return "light";
  return view?.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Calls back whenever the host page's scheme may have changed. */
export function watchScheme(doc: Document, onChange: () => void): () => void {
  const view = doc.defaultView;
  const observer = view ? new view.MutationObserver(onChange) : undefined;
  const filter = { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-scheme"] };
  observer?.observe(doc.documentElement, filter);
  if (doc.body) observer?.observe(doc.body, filter);
  const media = view?.matchMedia?.("(prefers-color-scheme: dark)");
  media?.addEventListener?.("change", onChange);
  return () => {
    observer?.disconnect();
    media?.removeEventListener?.("change", onChange);
  };
}
