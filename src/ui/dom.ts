/** Small DOM builders. No innerHTML anywhere, so host pages with Trusted Types stay happy. */

export type Child = Node | string | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string | undefined>;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
}

export type Builder = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
) => HTMLElementTagNameMap[K];

export function builder(doc: Document): Builder {
  return (tag, props, ...children) => {
    const node = doc.createElement(tag);
    if (props?.class) node.className = props.class;
    if (props?.text !== undefined) node.textContent = props.text;
    if (props?.title) node.title = props.title;
    for (const [name, value] of Object.entries(props?.attrs ?? {}))
      if (value !== undefined) node.setAttribute(name, value);
    for (const [type, listener] of Object.entries(props?.on ?? {}))
      if (listener) node.addEventListener(type, listener);
    for (const child of children)
      if (child !== null && child !== undefined && child !== false)
        node.append(typeof child === "string" ? doc.createTextNode(child) : child);
    return node;
  };
}

const SVG = "http://www.w3.org/2000/svg";

const ICONS = {
  chevron: ["M3 4.5 6 7.5 9 4.5"],
  pencil: ["M8.6 2.4l3 3L5 12H2v-3z", "M7.4 3.6l3 3"],
  check: ["M2.8 7.4 5.6 10.2 11.2 3.8"],
  close: ["M3.5 3.5l7 7", "M10.5 3.5l-7 7"],
  open: ["M5.5 3H3v8h8V8.5", "M8 2h4v4", "M12 2 6.5 7.5"],
  list: ["M5 3.5h7", "M5 7h7", "M5 10.5h7", "M2.2 3.5h.6", "M2.2 7h.6", "M2.2 10.5h.6"],
  diamond: ["M7 2.5 11.5 7 7 11.5 2.5 7z"],
  plus: ["M7 3v8", "M3 7h8"],
  bell: ["M7 1.9a3.3 3.3 0 0 0-3.3 3.3v2.4L2.4 9.7h9.2L10.3 7.6V5.2A3.3 3.3 0 0 0 7 1.9z", "M5.7 11.4a1.4 1.4 0 0 0 2.6 0"],
  search: ["M6.2 10.4a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4z", "M9.3 9.3l3.1 3.1"],
} as const;

export type IconName = keyof typeof ICONS;

export function icon(doc: Document, name: IconName, className?: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG, "svg");
  const size = name === "chevron" ? "12" : "14";
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  for (const d of ICONS[name]) {
    const path = doc.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Attaches CSS to a shadow root the way codexhost's own extension surfaces do. */
export function adoptStyles(root: ShadowRoot, css: string): void {
  const view = root.ownerDocument.defaultView;
  const Sheet = view?.CSSStyleSheet;
  if (Sheet && "adoptedStyleSheets" in root) {
    try {
      const sheet = new Sheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
      return;
    } catch {
      // Fall back to a style element below.
    }
  }
  const style = root.ownerDocument.createElement("style");
  style.textContent = css;
  root.append(style);
}
