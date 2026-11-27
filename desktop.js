(() => {
  // src/core/redact.ts
  var MASK = "***";
  var KEY = String.raw`[A-Za-z0-9_.-]{0,64}?(?:passw(?:or)?d|secret(?:[_-]?key)?|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?`;
  var NOT_A_SECRET = /^(?:\d{1,6}|true|false|null|none|nil|undefined|string|number|boolean|bool|str|int|bytes|any|object|optional|required|[$%].*|process\.env\b.*|(?:os\.)?(?:environ|getenv)\b.*)$/iu;
  var assigned = (match, keyQuote = "", key = "", separator = "", valueQuote = "", value = "") => NOT_A_SECRET.test(value) || value.includes(MASK) ? match : `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${MASK}${valueQuote}`;
  var RULES = [
    // PEM private keys, also when the text was cut off before their last line.
    [/-----BEGIN ([A-Z0-9 ]*?)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/gu, () => "[private key]"],
    // scheme://user:password@host
    [/\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/?#@]+:)[^\s/?#@]+@/giu, (_match, head2 = "") => `${head2}${MASK}@`],
    // Anthropic, OpenAI and similar keys; a real one has a digit early on.
    [/\bsk-(?=[A-Za-z0-9_-]{0,128}\d)[A-Za-z0-9_-]{16,}/gu, () => `sk-${MASK}`],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/gu, () => `github_pat_${MASK}`],
    [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/gu, (_match, prefix = "") => `${prefix}${MASK}`],
    [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/gu, (_match, prefix = "") => `${prefix}${MASK}`],
    [/\b(xox[a-z])-[A-Za-z0-9-]{10,}/gu, (_match, prefix = "") => `${prefix}-${MASK}`],
    // JSON Web Tokens: base64 of `{"…` twice, then the signature.
    [/\beyJ[A-Za-z0-9_-]{5,512}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/gu, () => `eyJ${MASK}`],
    // A credential after Bearer has a digit; "Bearer authentication" in prose stays.
    [/\b(Bearer)\s+(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{8,}=*/giu, (_match, word = "") => `${word} ${MASK}`],
    // password="two words", "token": "…"
    [new RegExp(String.raw`(["']?)\b(${KEY})\1(\s*[:=]\s*)(["'])([^"'\n]{3,}?)\4`, "giu"), assigned],
    // PASSWORD=hunter2, api_key: abc123 (the empty group keeps the value where the quoted rule has it)
    [new RegExp(String.raw`(["']?)\b(${KEY})\1(\s*[:=]\s*)()(?!["'])([^\s"'\x60,;&<>()[\]{}]{3,})`, "giu"), assigned],
    [/(密码|口令|密钥|令牌|验证码)(\s*[:：=]\s*)([^\s，。；,;]{3,})/gu, (match, key = "", separator = "", value = "") => value.includes(MASK) ? match : `${key}${separator}${MASK}`]
  ];

  // src/core/model.ts
  var LIMITS = {
    /** Characters kept from any single piece of text. */
    text: 300,
    /** Done items kept per mainline; the oldest go first. */
    done: 100,
    /** Parked items kept per mainline. */
    parked: 50,
    /**
     * The state file may not grow past this: room for a summarized mainline on thousands of
     * conversations. (How many mainlines are kept is MAX_CONVERSATIONS, core/conversation-ops.ts.)
     */
    stateBytes: 8 * 1024 * 1024
  };
  var DEFAULT_SETTINGS = {
    driftPolicy: "ask",
    showCapsule: false,
    prAlerts: true,
    autoSummarize: true,
    summarizeModel: "follow",
    summarizeOthers: "none"
  };
  var ERROR_CODES = [
    /** A request the code does not take; the message says why. */
    "INVALID_ARGUMENT",
    /** A text (a title, a task, a passage) that is empty. */
    "EMPTY_TEXT",
    /** No conversation: none is current (command line), or codexhost does not know it. */
    "NO_THREAD",
    /** The conversation has no mainline, or the user deleted it. */
    "NO_MAINLINE",
    /** Reaching a milestone when there is no current one. */
    "NO_CURRENT_MILESTONE",
    /** A milestone, task, spin-off or saved passage that is not there (any more). */
    "UNKNOWN_ITEM",
    "MILESTONE_EXISTS",
    /** A mainline has at most V2_LIMITS.milestones milestones. */
    "MILESTONE_LIMIT",
    /** Another writer holds the data; trying again in a moment works. */
    "LOCKED",
    /** The state is at its size or at MAX_CONVERSATIONS, and nothing can make room. */
    "STATE_FULL",
    "FAVORITES_FULL",
    /** Another data file of the extension is at its size cap; the message names it. */
    "FILE_FULL",
    /** An answer to a surface would be too large to send. */
    "TOO_LARGE",
    "ATTACHMENT_TOO_LARGE",
    "TOO_MANY_ATTACHMENTS",
    /** Too many uploads, or too many bytes, wait to be sent with a child conversation. */
    "UPLOADS_BUSY",
    "CHILD_FILES_TOO_LARGE",
    /** No model is set for conversations of this agent (`summarizeOthers` is "none"). */
    "NO_SUMMARIZER",
    /** An agent's configuration cannot be read or changed (the agent integration). */
    "UNAVAILABLE",
    /** A data file was written by a newer version of the extension: it is left as it is. */
    "NEWER_VERSION",
    /** codexhost has not answered in time: the child conversation may still open in the background. */
    "PENDING",
    /**
     * Files sent along with a child conversation on another computer (a remote host): it opens there,
     * and that computer cannot read the files kept on this one.
     */
    "REMOTE_ATTACHMENTS"
  ];
  function isErrorCode(value) {
    return typeof value === "string" && ERROR_CODES.includes(value);
  }
  var MainlineError = class extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
      this.name = "MainlineError";
    }
    code;
  };
  function cleanText(input, field = "text") {
    if (typeof input !== "string") throw new MainlineError("EMPTY_TEXT", `${field} is required`);
    const text = input.replace(/\s+/gu, " ").trim();
    if (!text) throw new MainlineError("EMPTY_TEXT", `${field} is empty`);
    const chars = Array.from(text);
    return chars.length > LIMITS.text ? `${chars.slice(0, LIMITS.text - 1).join("")}\u2026` : text;
  }
  var LETTERS = "abcdefghijklmnopqrstuvwxyz";
  var ALPHANUMERIC = `${LETTERS}0123456789`;
  var THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u;
  var DRAFT_ID = /^(?:draft-|client-new-thread:)/u;
  var OBJECT_KEYS = /* @__PURE__ */ new Set(["constructor", "prototype", "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable"]);
  function isDraftId(value) {
    return typeof value === "string" && DRAFT_ID.test(value);
  }
  function isThreadId(value) {
    return typeof value === "string" && THREAD_ID.test(value) && !OBJECT_KEYS.has(value) && !isDraftId(value);
  }
  function localeOf(value) {
    return typeof value === "string" && value.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  }

  // src/core/rpc.ts
  function errorCodeOf(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /^\[([A-Z_]+)\]/u.exec(message)?.[1];
  }

  // src/ui/dom.ts
  function builder(doc) {
    return (tag, props, ...children2) => {
      const node = doc.createElement(tag);
      if (props?.class) node.className = props.class;
      if (props?.text !== void 0) node.textContent = props.text;
      if (props?.title) node.title = props.title;
      for (const [name, value] of Object.entries(props?.attrs ?? {}))
        if (value !== void 0) node.setAttribute(name, value);
      for (const [type, listener] of Object.entries(props?.on ?? {}))
        if (listener) node.addEventListener(type, listener);
      for (const child of children2)
        if (child !== null && child !== void 0 && child !== false)
          node.append(typeof child === "string" ? doc.createTextNode(child) : child);
      return node;
    };
  }
  var SVG = "http://www.w3.org/2000/svg";
  var ICONS = {
    chevron: ["M3 4.5 6 7.5 9 4.5"],
    pencil: ["M8.6 2.4l3 3L5 12H2v-3z", "M7.4 3.6l3 3"],
    check: ["M2.8 7.4 5.6 10.2 11.2 3.8"],
    close: ["M3.5 3.5l7 7", "M10.5 3.5l-7 7"],
    open: ["M5.5 3H3v8h8V8.5", "M8 2h4v4", "M12 2 6.5 7.5"],
    list: ["M5 3.5h7", "M5 7h7", "M5 10.5h7", "M2.2 3.5h.6", "M2.2 7h.6", "M2.2 10.5h.6"],
    diamond: ["M7 2.5 11.5 7 7 11.5 2.5 7z"],
    plus: ["M7 3v8", "M3 7h8"],
    bell: ["M7 1.9a3.3 3.3 0 0 0-3.3 3.3v2.4L2.4 9.7h9.2L10.3 7.6V5.2A3.3 3.3 0 0 0 7 1.9z", "M5.7 11.4a1.4 1.4 0 0 0 2.6 0"],
    search: ["M6.2 10.4a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4z", "M9.3 9.3l3.1 3.1"]
  };
  function icon(doc, name, className) {
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
  function adoptStyles(root, css2) {
    const view = root.ownerDocument.defaultView;
    const Sheet = view?.CSSStyleSheet;
    if (Sheet && "adoptedStyleSheets" in root) {
      try {
        const sheet = new Sheet();
        sheet.replaceSync(css2);
        root.adoptedStyleSheets = [sheet];
        return;
      } catch {
      }
    }
    const style = root.ownerDocument.createElement("style");
    style.textContent = css2;
    root.append(style);
  }
  function documentStyles(doc, css2) {
    const Sheet = doc.defaultView?.CSSStyleSheet;
    if (Sheet && "adoptedStyleSheets" in doc) {
      try {
        const sheet = new Sheet();
        sheet.replaceSync(css2);
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
        return () => {
          doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((item) => item !== sheet);
        };
      } catch {
      }
    }
    const style = doc.createElement("style");
    style.setAttribute("data-codexhost-mainline-styles", "");
    style.textContent = css2;
    (doc.head ?? doc.documentElement).append(style);
    return () => style.remove();
  }

  // src/core/attachments.ts
  var ATTACH_CHUNK_BYTES = 512 * 1024;
  var ATTACH_MAX_FILES = 10;
  var ATTACH_MAX_FILE_BYTES = 500 * 1024 * 1024;
  var ATTACH_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
  var IMAGE = /\.(png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff?|svg)$/iu;
  var VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|3gp|mpe?g)$/iu;
  function attachmentKind(name, type = "") {
    if (type.startsWith("image/")) return "image";
    if (type.startsWith("video/")) return "video";
    if (IMAGE.test(name)) return "image";
    if (VIDEO.test(name)) return "video";
    return "file";
  }
  function formatSize(bytes) {
    const KB = 1024;
    const MB = KB * 1024;
    const GB = MB * 1024;
    const fixed = (value, digits) => value.toFixed(digits).replace(/\.0$/u, "");
    if (bytes < KB) return `${bytes} B`;
    if (bytes < MB) return `${Math.max(1, Math.round(bytes / KB))} KB`;
    if (bytes < GB) return `${fixed(bytes / MB, bytes < 10 * MB ? 1 : 0)} MB`;
    return `${fixed(bytes / GB, 1)} GB`;
  }

  // src/core/conversation.ts
  var V2_LIMITS = {
    title: 120,
    tags: 8,
    tag: 24,
    milestones: 30,
    tasks: 60,
    spinoffs: 30
  };

  // src/ui/i18n.ts
  function errorDetail(message) {
    return message.replace(/^\[[A-Z_]+\]\s*/u, "");
  }
  var MAX_FILE = formatSize(ATTACH_MAX_FILE_BYTES);
  var MAX_TOTAL = formatSize(ATTACH_MAX_TOTAL_BYTES);
  var ZH_ERRORS = {
    INVALID_ARGUMENT: (detail) => `\u6CA1\u6709\u6539\u6210\uFF1A${detail}`,
    EMPTY_TEXT: () => "\u6CA1\u6709\u6539\u6210\uFF1A\u5185\u5BB9\u4E3A\u7A7A",
    NO_THREAD: () => "\u627E\u4E0D\u5230\u8FD9\u4E2A\u5BF9\u8BDD",
    NO_MAINLINE: () => "\u672C\u5BF9\u8BDD\u8FD8\u6CA1\u6709\u4E3B\u7EBF",
    NO_CURRENT_MILESTONE: () => "\u6CA1\u6709\u5F53\u524D\u91CC\u7A0B\u7891\u53EF\u4EE5\u8FBE\u6210",
    UNKNOWN_ITEM: () => "\u8FD9\u4E00\u9879\u5DF2\u7ECF\u4E0D\u5B58\u5728\u4E86",
    MILESTONE_EXISTS: () => "\u6CA1\u6709\u6539\u6210\uFF1A\u8FD9\u4E2A\u91CC\u7A0B\u7891\u5DF2\u7ECF\u6709\u4E86",
    MILESTONE_LIMIT: () => `\u4E00\u6761\u4E3B\u7EBF\u6700\u591A ${V2_LIMITS.milestones} \u4E2A\u91CC\u7A0B\u7891\uFF0C\u8BF7\u5148\u5220\u6389\u4E0D\u7528\u7684\u91CC\u7A0B\u7891`,
    LOCKED: () => "\u4E3B\u7EBF\u6570\u636E\u6B63\u5728\u5199\u5165\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5",
    STATE_FULL: () => "\u4E3B\u7EBF\u6570\u636E\u5DF2\u6EE1\uFF0C\u8BF7\u5728\u603B\u89C8\u9875\u5220\u9664\u4E0D\u7528\u7684\u4E3B\u7EBF",
    FAVORITES_FULL: () => "\u6536\u85CF\u5DF2\u6EE1\uFF0C\u8BF7\u5728\u603B\u89C8\u9875\u300C\u6536\u85CF\u300D\u91CC\u5220\u9664\u4E0D\u7528\u7684\u6536\u85CF",
    FILE_FULL: (detail) => `\u6570\u636E\u6587\u4EF6\u5DF2\u6EE1\uFF0C\u8FD9\u6B21\u6CA1\u6709\u4FDD\u5B58\uFF08${detail}\uFF09`,
    TOO_LARGE: (detail) => `\u8D85\u51FA\u4E0A\u9650\uFF1A${detail}`,
    ATTACHMENT_TOO_LARGE: () => `\u5355\u4E2A\u9644\u4EF6\u4E0D\u80FD\u8D85\u8FC7 ${MAX_FILE}`,
    TOO_MANY_ATTACHMENTS: () => `\u6700\u591A\u9644\u5E26 ${ATTACH_MAX_FILES} \u4E2A\u6587\u4EF6`,
    UPLOADS_BUSY: () => "\u7B49\u7740\u53D1\u9001\u7684\u9644\u4EF6\u592A\u591A\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5",
    CHILD_FILES_TOO_LARGE: () => `\u4E00\u4E2A\u5B50\u5BF9\u8BDD\u7684\u9644\u4EF6\u5408\u8BA1\u4E0D\u80FD\u8D85\u8FC7 ${MAX_TOTAL}`,
    NO_SUMMARIZER: () => "\u6CA1\u6709\u51DD\u7EC3\uFF1A\u6309\u8BBE\u7F6E\uFF0C\u8FD9\u4E2A Agent \u7684\u5BF9\u8BDD\u4E0D\u53D1\u7ED9\u6A21\u578B\u3002\u8981\u51DD\u7EC3\uFF0C\u8BF7\u5728\u603B\u89C8\u9875\u300C\u8BBE\u7F6E\u300D\u91CC\u4E3A\u300C\u5176\u4ED6 Agent\uFF08\u5982 pi\u3001DeepSeek\u3001Grok\uFF09\u7684\u5BF9\u8BDD\u300D\u9009\u4E00\u4E2A\u6A21\u578B",
    UNAVAILABLE: (detail) => `\u6539\u4E0D\u4E86 Agent \u534F\u4F5C\uFF1A${detail}`,
    NEWER_VERSION: () => "\u6570\u636E\u6587\u4EF6\u662F\u66F4\u65B0\u7248\u672C\u7684\u7B2C\u4E8C\u5927\u8111\u63D2\u4EF6\u5199\u7684\uFF0C\u8FD9\u91CC\u6CA1\u6709\u6539\u52A8\u5B83\uFF1B\u8BF7\u66F4\u65B0\u63D2\u4EF6",
    PENDING: () => "codexhost \u6CA1\u6709\u53CA\u65F6\u7B54\u590D\uFF0C\u5B50\u5BF9\u8BDD\u53EF\u80FD\u8FD8\u5728\u6253\u5F00\uFF1A\u5F00\u597D\u540E\u4F1A\u51FA\u73B0\u5728\u672C\u5BF9\u8BDD\u4E0B\u65B9\uFF0C\u5148\u4E0D\u8981\u518D\u70B9",
    REMOTE_ATTACHMENTS: () => "\u8FD9\u4E2A\u5BF9\u8BDD\u5728\u53E6\u4E00\u53F0\u7535\u8111\u4E0A\uFF0C\u5B50\u5BF9\u8BDD\u4E5F\u5F00\u5728\u90A3\u91CC\uFF0C\u90A3\u53F0\u7535\u8111\u8BFB\u4E0D\u5230\u672C\u673A\u7684\u6587\u4EF6\uFF1A\u5F00\u5B50\u5BF9\u8BDD\u65F6\u4E0D\u80FD\u9644\u5E26\u7167\u7247\u3001\u6587\u4EF6\u6216\u89C6\u9891"
  };
  var EN_ERRORS = {
    INVALID_ARGUMENT: (detail) => `Not changed: ${detail}`,
    EMPTY_TEXT: () => "Not changed: the text is empty",
    NO_THREAD: () => "That conversation cannot be found",
    NO_MAINLINE: () => "This conversation has no mainline",
    NO_CURRENT_MILESTONE: () => "There is no current milestone to reach",
    UNKNOWN_ITEM: () => "That item no longer exists",
    MILESTONE_EXISTS: () => "Not changed: that milestone exists already",
    MILESTONE_LIMIT: () => `A mainline has at most ${V2_LIMITS.milestones} milestones; delete one you no longer need first`,
    LOCKED: () => "The mainline data is being written; try again in a moment",
    STATE_FULL: () => "The mainline data is full; delete mainlines you no longer need in the overview",
    FAVORITES_FULL: () => "The saved passages are full; delete ones you no longer need in the overview's Favorites tab",
    FILE_FULL: (detail) => `A data file is full; nothing was saved (${detail})`,
    TOO_LARGE: (detail) => `Over the limit: ${detail}`,
    ATTACHMENT_TOO_LARGE: () => `One attachment may be ${MAX_FILE} at most`,
    TOO_MANY_ATTACHMENTS: () => `At most ${ATTACH_MAX_FILES} files`,
    UPLOADS_BUSY: () => "Too many files are waiting to be sent; try again in a moment",
    CHILD_FILES_TOO_LARGE: () => `The files of one child conversation may add up to ${MAX_TOTAL} at most`,
    NO_SUMMARIZER: () => "Not summarized: the settings send conversations of this agent to no model. To summarize it, choose a model under \u201CConversations of other agents (pi, DeepSeek, Grok, \u2026)\u201D in the overview's Settings tab",
    UNAVAILABLE: (detail) => `The agent integration cannot be changed: ${detail}`,
    NEWER_VERSION: () => "A data file was written by a newer version of Second Brain and was left as it is; update the extension",
    PENDING: () => "No answer from codexhost yet; the child may still open under this conversation",
    REMOTE_ATTACHMENTS: () => "This conversation is on another computer, where the child opens too, and that computer cannot read files on this one: no photos, files or videos can go along"
  };
  function errorText(table, fallback, code, message) {
    const detail = errorDetail(message);
    return isErrorCode(code) ? table[code](detail) : fallback(detail);
  }
  function relative(at, now, locale) {
    const minutes = Math.round((now - at) / 6e4);
    if (minutes < 1) return locale === "zh-CN" ? "\u521A\u521A" : "just now";
    if (minutes < 60) return locale === "zh-CN" ? `${minutes} \u5206\u949F\u524D` : `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return locale === "zh-CN" ? `${hours} \u5C0F\u65F6\u524D` : `${hours} h ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return locale === "zh-CN" ? `${days} \u5929\u524D` : `${days} d ago`;
    const date = new Date(at);
    return locale === "zh-CN" ? `${date.getMonth() + 1}\u6708${date.getDate()}\u65E5` : date.toLocaleDateString("en", { month: "short", day: "numeric" });
  }
  var zh = {
    mainline: "\u4E3B\u7EBF",
    doing: "\u6B63\u5728\u505A",
    noMainline: "\u672C\u5BF9\u8BDD\u8FD8\u6CA1\u6709\u4E3B\u7EBF",
    setAsMainline: "\u8BBE\u4E3A\u4E3B\u7EBF",
    goalPlaceholder: "\u8FD9\u4E2A\u5BF9\u8BDD\u5728\u505A\u4EC0\u4E48\uFF1F",
    dismiss: "\u5FFD\u7565",
    showLess: "\u6536\u8D77",
    complete: "\u5B8C\u6210",
    remove: "\u5220\u9664",
    edit: "\u4FEE\u6539",
    confirm: "\u518D\u70B9\u4E00\u6B21\u786E\u8BA4",
    armed: (label) => `${label}\uFF1A3 \u79D2\u5185\u518D\u70B9\u4E00\u6B21\u786E\u8BA4`,
    collapse: "\u6536\u8D77",
    offline: "\u7B2C\u4E8C\u5927\u8111\u7684\u540E\u53F0\u672A\u8FDE\u63A5\uFF0C\u6B63\u5728\u91CD\u8BD5",
    overviewHint: { desktop: "\u5B8C\u6574\u603B\u89C8\u4E0E Agent \u534F\u4F5C\uFF1A\u8BBE\u7F6E \u2192 \u63D2\u4EF6\u9875\u9762 \u2192 \u7B2C\u4E8C\u5927\u8111", web: "\u5B8C\u6574\u603B\u89C8\u4E0E Agent \u534F\u4F5C\uFF1A\u5DE6\u4FA7\u300C\u63D2\u4EF6\u300D\u2192\u300C\u7B2C\u4E8C\u5927\u8111\u300D" },
    agentHint: "\u5F00\u7740\u81EA\u52A8\u51DD\u7EC3\u65F6\uFF0C\u6A21\u578B\u4F1A\u5728\u56DE\u590D\u7ED3\u675F\u540E\u5199\u51FA\u4E3B\u7EBF\uFF1B\u88C5\u597D Agent \u534F\u4F5C\u540E\uFF0CAgent \u4F1A\u8FB9\u505A\u8FB9\u8BB0\u5F55\u652F\u7EBF\u4EFB\u52A1\u3002",
    status: { running: "\u8FD0\u884C\u4E2D", waiting: "\u7B49\u4F60\u5904\u7406", idle: "\u7A7A\u95F2", unknown: "\u72B6\u6001\u672A\u77E5" },
    open: "\u6253\u5F00",
    time: (at, now) => relative(at, now, "zh-CN"),
    error: (code, message) => errorText(ZH_ERRORS, (detail) => `\u64CD\u4F5C\u6CA1\u6709\u6210\u529F\uFF1A${detail}`, code, message),
    labelled: (label, text) => `${label}\uFF1A${text}`,
    counted: (title, done, total) => `${title}\uFF08${done}/${total}\uFF09`,
    joinParts: (parts) => parts.join("\uFF0C"),
    cardLabel: (title) => `\u4E3B\u7EBF\uFF1A${title}`,
    newsOne: (number) => `#${number} \u6709\u65B0\u52A8\u6001`,
    newsMany: (n) => `${n} \u4E2A PR/Issue \u6709\u65B0\u52A8\u6001`,
    news: "PR \u4E0E Issue \u65B0\u52A8\u6001",
    reason: (reason) => ({
      comment: "\u6709\u65B0\u8BC4\u8BBA",
      review: "\u6709\u65B0\u8BC4\u5BA1",
      approved: "\u8BC4\u5BA1\u901A\u8FC7",
      changes_requested: "\u8981\u6C42\u4FEE\u6539",
      merged: "\u5DF2\u5408\u5E76",
      review_requested: "\u8BF7\u4F60 review",
      mention: "\u63D0\u5230\u4E86\u4F60",
      author: "\u6709\u65B0\u52A8\u6001",
      state_change: "\u72B6\u6001\u53D8\u4E86",
      assign: "\u6307\u6D3E\u7ED9\u4F60",
      ci_activity: "CI \u6709\u7ED3\u679C",
      manual: "\u6709\u65B0\u52A8\u6001",
      subscribed: "\u6709\u65B0\u52A8\u6001",
      team_mention: "\u63D0\u5230\u4E86\u4F60\u7684\u56E2\u961F"
    })[reason] ?? "\u6709\u65B0\u52A8\u6001",
    jump: "\u8DF3\u8F6C",
    inThisWindow: "\u5C31\u5728\u672C\u5BF9\u8BDD",
    turn: (n) => `\u7B2C ${n} \u8F6E`,
    asked: (text) => `\u5F53\u65F6\u7684\u95EE\u9898\uFF1A${text}`,
    noteLabel: (text) => `\u8BF4\u660E\uFF1A${text}`,
    windowRefs: "\u672C\u5BF9\u8BDD\u7684 PR \u4E0E Issue",
    noResults: "\u6CA1\u627E\u5230\u3002\u53EF\u4EE5\u6362\u6210 PR \u6216 issue \u7F16\u53F7\u3001\u94FE\u63A5\u91CC\u7684\u4E00\u6BB5\u3001\u6807\u7B7E\uFF0C\u6216\u5F53\u65F6\u95EE\u7684\u8BDD\u3002",
    kind: { pr: "PR", issue: "Issue" },
    refState: { open: "\u8FDB\u884C\u4E2D", closed: "\u5DF2\u5173\u95ED", merged: "\u5DF2\u5408\u5E76" },
    fromWindow: (title) => `\u6765\u6E90\u5BF9\u8BDD\u300C${title}\u300D`,
    draftLabel: "\u672A\u51DD\u7EC3",
    milestones: "\u91CC\u7A0B\u7891",
    noMilestones: "\u8FD8\u6CA1\u6709\u91CC\u7A0B\u7891\u3002\u91CC\u7A0B\u7891\u662F\u9636\u6BB5\u6027\u6210\u679C\uFF0C\u4F8B\u5982\u300C\u5B9A\u4F4D\u539F\u56E0\u300D\u300C\u63D0\u4EA4 PR\u300D\u300C\u5408\u5E76\u9A8C\u8BC1\u300D\u3002",
    reach: "\u8FBE\u6210\u672C\u9636\u6BB5",
    addMilestone: "\u6DFB\u52A0\u91CC\u7A0B\u7891\u2026",
    makeCurrent: "\u8BBE\u4E3A\u5F53\u524D",
    addTask: "\u8BB0\u4E00\u6761\u652F\u7EBF\u4EFB\u52A1\u2026",
    tasksCount: (n) => `${n} \u4E2A\u652F\u7EBF\u4EFB\u52A1`,
    earlierMilestones: (n) => `\u8FD8\u6709 ${n} \u4E2A\u66F4\u65E9\u7684\u91CC\u7A0B\u7891`,
    byChild: (title) => `\u5B50\u5BF9\u8BDD\u300C${title}\u300D`,
    spinoffs: "\u5F15\u7533\u95EE\u9898",
    spawnChild: "\u5F00\u5B50\u5BF9\u8BDD",
    keepHere: "\u672C\u5BF9\u8BDD\u5904\u7406",
    spawned: (title) => `\u5DF2\u5F00\u5B50\u5BF9\u8BDD\uFF1A${title}`,
    children: "\u5B50\u5BF9\u8BDD",
    fromParent: (title) => `\u6765\u81EA\uFF1A${title}`,
    linkedTo: (title) => `\u5173\u8054\uFF1A${title}`,
    conversationStatus: { active: "\u8FDB\u884C\u4E2D", paused: "\u5DF2\u6682\u505C", done: "\u5DF2\u5B8C\u6210" },
    pause: "\u6682\u505C",
    resume: "\u7EE7\u7EED",
    finishMainline: "\u5B8C\u6210\u4E3B\u7EBF",
    reopenMainline: "\u91CD\u65B0\u6253\u5F00",
    editTags: "\u6539\u6807\u7B7E",
    tagsPlaceholder: "\u6807\u7B7E\uFF0C\u7528\u9017\u53F7\u5206\u9694\uFF1A\u9879\u76EE\u3001\u6A21\u5757\u3001\u7C7B\u578B\u3001\u7F16\u53F7",
    planPlaceholder: "\u91CC\u7A0B\u7891\uFF08\u53EF\u9009\uFF09\uFF0C\u7528 | \u5206\u9694\uFF1A\u5B9A\u4F4D\u539F\u56E0|\u63D0\u4EA4 PR|\u5408\u5E76\u9A8C\u8BC1",
    firstPromptLabel: (text) => `\u8D77\u56E0\uFF1A${text}`,
    lastPromptLabel: (text) => `\u6700\u8FD1\u8BF7\u6C42\uFF1A${text}`,
    findConversations: "\u627E\u5BF9\u8BDD",
    findConversationsPlaceholder: "\u7F16\u53F7\u3001\u94FE\u63A5\u6216\u5173\u952E\u8BCD\uFF0C\u4F8B\u5982 42\u3001\u767B\u5F55\u9875",
    matchField: { ref: "PR/Issue", tag: "\u6807\u7B7E", title: "\u4E3B\u7EBF", milestone: "\u91CC\u7A0B\u7891", task: "\u652F\u7EBF\u4EFB\u52A1", spinoff: "\u5F15\u7533\u95EE\u9898", prompt: "\u5F53\u65F6\u7684\u95EE\u9898", threadTitle: "\u5BF9\u8BDD\u6807\u9898", favorite: "\u6536\u85CF" },
    progress: (done, total) => `\u25C6 ${done}/${total}`,
    current: (title) => `\u25CF ${title}`
  };
  var en = {
    mainline: "Mainline",
    doing: "Doing",
    noMainline: "This conversation has no mainline",
    setAsMainline: "Set as mainline",
    goalPlaceholder: "What is this conversation doing?",
    dismiss: "Dismiss",
    showLess: "Show less",
    complete: "Done",
    remove: "Remove",
    edit: "Edit",
    confirm: "Click again to confirm",
    armed: (label) => `${label}: click again within 3 seconds to confirm`,
    collapse: "Collapse",
    offline: "Second Brain's backend is unreachable, retrying",
    overviewHint: { desktop: "Overview and agent setup: Settings \u2192 Plugin pages \u2192 Second Brain", web: "Overview and agent setup: Plugins \u2192 Second Brain" },
    agentHint: "With automatic summaries on, a model writes the mainline after a reply; with the agent integration installed, agents record tasks as they work.",
    status: { running: "Running", waiting: "Needs you", idle: "Idle", unknown: "Unknown" },
    open: "Open",
    time: (at, now) => relative(at, now, "en"),
    error: (code, message) => errorText(EN_ERRORS, (detail) => `That did not work: ${detail}`, code, message),
    labelled: (label, text) => `${label}: ${text}`,
    counted: (title, done, total) => `${title} (${done}/${total})`,
    joinParts: (parts) => parts.join(", "),
    cardLabel: (title) => `Mainline: ${title}`,
    newsOne: (number) => `#${number} has news`,
    newsMany: (n) => `${n} PRs or issues have news`,
    news: "PR and issue news",
    reason: (reason) => ({
      comment: "New comment",
      review: "New review",
      approved: "Approved",
      changes_requested: "Changes requested",
      merged: "Merged",
      review_requested: "Review requested",
      mention: "You were mentioned",
      author: "New activity",
      state_change: "State changed",
      assign: "Assigned to you",
      ci_activity: "CI finished",
      manual: "New activity",
      subscribed: "New activity",
      team_mention: "Your team was mentioned"
    })[reason] ?? "New activity",
    jump: "Go",
    inThisWindow: "This conversation",
    turn: (n) => `turn ${n}`,
    asked: (text) => `Asked then: ${text}`,
    noteLabel: (text) => `Note: ${text}`,
    windowRefs: "PRs and issues of this conversation",
    noResults: "Nothing found. Try a PR or issue number, part of a link, a tag or words from the request.",
    kind: { pr: "PR", issue: "Issue" },
    refState: { open: "Open", closed: "Closed", merged: "Merged" },
    fromWindow: (title) => `From "${title}"`,
    draftLabel: "Not summarized",
    milestones: "Milestones",
    noMilestones: 'No milestones yet. Milestones are stage results, such as "find the cause", "open the PR", "verify after merge".',
    reach: "Stage reached",
    addMilestone: "Add a milestone\u2026",
    makeCurrent: "Make current",
    addTask: "Add a task\u2026",
    tasksCount: (n) => `${n} task${n === 1 ? "" : "s"}`,
    earlierMilestones: (n) => `${n} earlier milestone${n === 1 ? "" : "s"}`,
    byChild: (title) => `child conversation "${title}"`,
    spinoffs: "Spin-offs",
    spawnChild: "Child conversation",
    keepHere: "Handle here",
    spawned: (title) => `Child conversation: ${title}`,
    children: "Child conversations",
    fromParent: (title) => `From: ${title}`,
    linkedTo: (title) => `Linked: ${title}`,
    conversationStatus: { active: "Active", paused: "Paused", done: "Done" },
    pause: "Pause",
    resume: "Resume",
    finishMainline: "Finish",
    reopenMainline: "Reopen",
    editTags: "Edit tags",
    tagsPlaceholder: "Tags, separated by commas: project, area, kind, numbers",
    planPlaceholder: "Milestones (optional), separated by |: find the cause|open the PR|verify",
    firstPromptLabel: (text) => `Started with: ${text}`,
    lastPromptLabel: (text) => `Last request: ${text}`,
    findConversations: "Find a conversation",
    findConversationsPlaceholder: "Number, link or words, for example 42 or login page",
    matchField: { ref: "PR/issue", tag: "tag", title: "mainline", milestone: "milestone", task: "task", spinoff: "spin-off", prompt: "request", threadTitle: "conversation title", favorite: "saved passage" },
    progress: (done, total) => `\u25C6 ${done}/${total}`,
    current: (title) => `\u25CF ${title}`
  };
  function strings(locale) {
    return locale === "zh-CN" ? zh : en;
  }

  // src/ui/theme.ts
  function parseColor(value) {
    const match = /rgba?\(([^)]+)\)/u.exec(value);
    if (!match?.[1]) return void 0;
    const parts = match[1].split(/[\s,/]+/u).filter(Boolean).map(Number);
    const [r = 0, g = 0, b = 0, a = 1] = parts;
    return [r, g, b, a];
  }
  function luminance([r, g, b]) {
    const channel = (value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }
  function detectScheme(doc, probe) {
    const view = doc.defaultView;
    const candidates = [probe, doc.body, doc.documentElement].filter((node) => Boolean(node));
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
  function watchScheme(doc, onChange) {
    const view = doc.defaultView;
    const observer = view ? new view.MutationObserver(onChange) : void 0;
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

  // src/ui/capsule.ts
  var css = true ? ':host {\n  all: initial;\n}\n\n/*\n * Text reads at 4.5:1 or more in both schemes, also on the hover, accent and amber tints: hence\n * the faint grey close to the muted one, and --cxm-accent-text for accent text on an accent tint.\n */\n.root {\n  --cxm-bg: rgba(255, 255, 255, 0.92);\n  --cxm-bg-solid: #ffffff;\n  --cxm-fg: #1f2328;\n  --cxm-muted: #626a75;\n  --cxm-faint: #646b75;\n  --cxm-border: rgba(15, 23, 42, 0.12);\n  --cxm-hover: rgba(15, 23, 42, 0.055);\n  --cxm-accent: #2563eb;\n  --cxm-accent-text: #1d4ed8;\n  --cxm-accent-soft: rgba(37, 99, 235, 0.1);\n  --cxm-amber: #a35a06;\n  --cxm-amber-dot: #f59e0b;\n  --cxm-amber-soft: rgba(245, 158, 11, 0.13);\n  --cxm-amber-line: rgba(245, 158, 11, 0.45);\n  --cxm-ok: #15803d;\n  --cxm-danger: #c42b2b;\n  --cxm-shadow: 0 1px 2px rgba(15, 23, 42, 0.06), 0 10px 28px rgba(15, 23, 42, 0.12);\n  position: relative;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;\n  font-size: 13px;\n  line-height: 1.45;\n  color: var(--cxm-fg);\n  text-align: left;\n  -webkit-font-smoothing: antialiased;\n}\n\n.root[data-scheme="dark"] {\n  --cxm-bg: rgba(38, 39, 43, 0.9);\n  --cxm-bg-solid: #26272b;\n  --cxm-fg: #e8e8ea;\n  --cxm-muted: #a3a7ae;\n  --cxm-faint: #9ba0a7;\n  --cxm-border: rgba(255, 255, 255, 0.13);\n  --cxm-hover: rgba(255, 255, 255, 0.07);\n  --cxm-accent: #7aa7ff;\n  --cxm-accent-text: #7aa7ff;\n  --cxm-accent-soft: rgba(122, 167, 255, 0.12);\n  --cxm-amber: #f5bd5a;\n  --cxm-amber-dot: #f5a524;\n  --cxm-amber-soft: rgba(245, 165, 36, 0.14);\n  --cxm-amber-line: rgba(245, 165, 36, 0.45);\n  --cxm-ok: #5bd18b;\n  --cxm-danger: #ff7b72;\n  --cxm-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 12px 32px rgba(0, 0, 0, 0.38);\n}\n\n.root[hidden] {\n  display: none;\n}\n\n/* Read by screen readers, not shown. */\n.sr-only {\n  position: absolute;\n  width: 1px;\n  height: 1px;\n  overflow: hidden;\n  clip: rect(0 0 0 0);\n  white-space: nowrap;\n}\n\n/* ---------------------------------------------------------------- capsule */\n\n.capsule {\n  display: inline-flex;\n  align-items: center;\n  gap: 8px;\n  box-sizing: border-box;\n  max-width: min(660px, calc(100vw - 24px));\n  height: 30px;\n  padding: 0 10px;\n  border: 1px solid var(--cxm-border);\n  border-radius: 15px;\n  background: var(--cxm-bg);\n  box-shadow: var(--cxm-shadow);\n  -webkit-backdrop-filter: saturate(1.5) blur(14px);\n  backdrop-filter: saturate(1.5) blur(14px);\n  color: var(--cxm-fg);\n  font-size: 12.5px;\n  white-space: nowrap;\n  cursor: pointer;\n  user-select: none;\n  -webkit-user-select: none;\n  touch-action: none;\n  outline: none;\n  transition: box-shadow 0.15s ease, border-color 0.15s ease;\n}\n\n.capsule:hover,\n.capsule:focus-visible {\n  border-color: var(--cxm-faint);\n}\n\n.capsule:focus-visible {\n  box-shadow: 0 0 0 3px var(--cxm-accent-soft), var(--cxm-shadow);\n}\n\n.capsule[data-drift] {\n  border-color: var(--cxm-amber-line);\n  background: linear-gradient(var(--cxm-amber-soft), var(--cxm-amber-soft)), var(--cxm-bg);\n}\n\n.capsule[data-empty] {\n  gap: 4px;\n  padding: 0 11px 0 9px;\n  color: var(--cxm-muted);\n}\n\n.root[data-dragging] .capsule {\n  cursor: grabbing;\n}\n\n.dot {\n  flex: none;\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  background: var(--cxm-accent);\n}\n\n.dot[data-tone="drift"] {\n  background: var(--cxm-amber-dot);\n}\n\n.dot[data-tone="muted"] {\n  background: var(--cxm-faint);\n}\n\n.capsule .label {\n  flex: none;\n  color: var(--cxm-muted);\n}\n\n.capsule .goal {\n  min-width: 0;\n  max-width: 240px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  font-weight: 600;\n}\n\n.capsule .sep {\n  flex: none;\n  width: 1px;\n  height: 12px;\n  background: var(--cxm-border);\n}\n\n.capsule .doing {\n  min-width: 0;\n  max-width: 210px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--cxm-muted);\n}\n\n.capsule .drift-text {\n  min-width: 0;\n  max-width: 210px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--cxm-amber);\n  font-weight: 500;\n}\n\n.capsule .count {\n  flex: none;\n  padding: 0 6px;\n  border-radius: 8px;\n  background: var(--cxm-hover);\n  color: var(--cxm-muted);\n  font-size: 11.5px;\n  line-height: 18px;\n}\n\n/* On the amber tint the grey chip would be too faint to read. */\n.capsule[data-drift] .count {\n  background: var(--cxm-bg-solid);\n}\n\n.chevron {\n  flex: none;\n  width: 12px;\n  height: 12px;\n  color: var(--cxm-muted);\n  transition: transform 0.16s ease;\n}\n\n.root[data-open] .chevron {\n  transform: rotate(180deg);\n}\n\n/* ---------------------------------------------------------------- card */\n\n.card {\n  position: absolute;\n  top: calc(100% + 8px);\n  left: 50%;\n  display: none;\n  box-sizing: border-box;\n  width: min(440px, calc(100vw - 24px));\n  max-height: var(--cxm-card-max, 70vh);\n  padding: 12px 14px 10px;\n  overflow: auto;\n  overscroll-behavior: contain;\n  transform: translateX(-50%);\n  border: 1px solid var(--cxm-border);\n  border-radius: 12px;\n  background: var(--cxm-bg-solid);\n  box-shadow: var(--cxm-shadow);\n  cursor: default;\n  white-space: normal;\n}\n\n.root[data-open] .card {\n  display: block;\n  animation: cxm-in 0.14s ease-out;\n}\n\n.root[data-flip] .card {\n  top: auto;\n  bottom: calc(100% + 8px);\n}\n\n@keyframes cxm-in {\n  from {\n    opacity: 0;\n    transform: translate(-50%, -4px);\n  }\n  to {\n    opacity: 1;\n    transform: translate(-50%, 0);\n  }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .root[data-open] .card {\n    animation: none;\n  }\n  .chevron,\n  .capsule {\n    transition: none;\n  }\n}\n\n.head {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n\n.tag {\n  color: var(--cxm-muted);\n  font-size: 11.5px;\n}\n\n.spacer {\n  flex: 1;\n}\n\n.goal-line {\n  display: flex;\n  align-items: flex-start;\n  gap: 4px;\n  margin: 2px 0 6px;\n  font-size: 15px;\n  font-weight: 600;\n  line-height: 1.38;\n  word-break: break-word;\n}\n\n.goal-line > span {\n  flex: 1;\n  min-width: 0;\n}\n\n.section {\n  margin-top: 10px;\n}\n\n.section-title {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  margin-bottom: 2px;\n  color: var(--cxm-muted);\n  font-size: 11.5px;\n  font-weight: 600;\n}\n\n.row {\n  display: flex;\n  align-items: flex-start;\n  gap: 8px;\n  margin: 0 -6px;\n  padding: 3px 6px;\n  border-radius: 6px;\n}\n\n.row:hover {\n  background: var(--cxm-hover);\n}\n\n.row[data-clickable] {\n  cursor: pointer;\n}\n\n.row[data-clickable]:focus-visible,\n.related:focus-visible {\n  outline: 2px solid var(--cxm-accent);\n  outline-offset: -2px;\n}\n\n.row .main {\n  flex: 1;\n  min-width: 0;\n  word-break: break-word;\n}\n\n.row .meta {\n  color: var(--cxm-faint);\n  font-size: 11.5px;\n}\n\n.row .actions {\n  display: flex;\n  flex: none;\n  gap: 2px;\n  opacity: 0;\n}\n\n.row:hover .actions,\n.row:focus-within .actions,\n.row .actions:has([data-confirm]) {\n  opacity: 1;\n}\n\n.who {\n  font-weight: 500;\n}\n\n.status {\n  flex: none;\n  width: 7px;\n  height: 7px;\n  margin-top: 6px;\n  border-radius: 50%;\n  background: var(--cxm-faint);\n}\n\n.status[data-status="running"] {\n  background: var(--cxm-accent);\n}\n\n.status[data-status="waiting"] {\n  background: var(--cxm-amber-dot);\n}\n\n.status[data-status="unknown"] {\n  background: transparent;\n  box-shadow: inset 0 0 0 1px var(--cxm-faint);\n}\n\n.mark {\n  flex: none;\n  width: 14px;\n  height: 14px;\n  margin-top: 2px;\n}\n\n.buttons {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px;\n}\n\nbutton {\n  font: inherit;\n  color: inherit;\n}\n\nbutton.btn {\n  padding: 2px 10px;\n  border: 1px solid var(--cxm-border);\n  border-radius: 6px;\n  background: transparent;\n  font-size: 12px;\n  line-height: 1.6;\n  cursor: pointer;\n}\n\nbutton.btn:hover {\n  background: var(--cxm-hover);\n}\n\nbutton.btn.primary {\n  border-color: var(--cxm-accent);\n  background: var(--cxm-accent);\n  color: #fff;\n}\n\n.root[data-scheme="dark"] button.btn.primary {\n  color: #10141c;\n}\n\nbutton.btn[data-confirm] {\n  border-color: var(--cxm-danger);\n  background: var(--cxm-danger);\n  color: #fff;\n}\n\n.root[data-scheme="dark"] button.btn[data-confirm] {\n  color: #10141c;\n}\n\nbutton.icon {\n  display: inline-grid;\n  place-items: center;\n  flex: none;\n  width: 22px;\n  height: 22px;\n  padding: 0;\n  border: 0;\n  border-radius: 5px;\n  background: transparent;\n  color: var(--cxm-muted);\n  cursor: pointer;\n}\n\nbutton.icon:hover {\n  background: var(--cxm-hover);\n  color: var(--cxm-fg);\n}\n\nbutton.icon svg {\n  width: 14px;\n  height: 14px;\n}\n\nbutton.link {\n  padding: 0;\n  border: 0;\n  background: none;\n  color: var(--cxm-accent);\n  font-size: 12px;\n  cursor: pointer;\n}\n\ninput.field {\n  box-sizing: border-box;\n  width: 100%;\n  padding: 4px 8px;\n  border: 1px solid var(--cxm-border);\n  border-radius: 6px;\n  outline: none;\n  background: transparent;\n  color: var(--cxm-fg);\n  font: inherit;\n}\n\ninput.field::placeholder {\n  color: var(--cxm-faint);\n}\n\ninput.field:focus {\n  border-color: var(--cxm-accent);\n  box-shadow: 0 0 0 3px var(--cxm-accent-soft);\n}\n\ninput.add {\n  margin-top: 4px;\n  border-style: dashed;\n  font-size: 12.5px;\n}\n\n.goal-line input.field {\n  font-size: 14px;\n  font-weight: 600;\n}\n\n.foot {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  margin-top: 12px;\n  padding-top: 8px;\n  border-top: 1px solid var(--cxm-border);\n}\n\n.hint {\n  margin-top: 8px;\n  color: var(--cxm-faint);\n  font-size: 11.5px;\n}\n\n.muted {\n  color: var(--cxm-muted);\n}\n\n.toast {\n  position: absolute;\n  top: calc(100% + 8px);\n  left: 50%;\n  z-index: 1;\n  max-width: min(420px, calc(100vw - 24px));\n  padding: 5px 10px;\n  transform: translateX(-50%);\n  border-radius: 6px;\n  background: var(--cxm-fg);\n  color: var(--cxm-bg-solid);\n  font-size: 12px;\n  white-space: normal;\n}\n\n.root[data-open] .toast {\n  top: auto;\n  bottom: calc(100% + 8px);\n}\n\n/* ---------------------------------------------------------------- PRs and issues */\n\n.capsule .alert {\n  display: inline-flex;\n  flex: none;\n  align-items: center;\n  gap: 4px;\n  padding: 0 8px 0 6px;\n  border-radius: 9px;\n  background: var(--cxm-accent-soft);\n  color: var(--cxm-accent-text);\n  font-size: 11.5px;\n  font-weight: 600;\n  line-height: 18px;\n  animation: cxm-pulse 1.4s ease-in-out 2;\n}\n\n.capsule .alert svg {\n  width: 12px;\n  height: 12px;\n}\n\n.capsule[data-alert] {\n  border-color: var(--cxm-accent);\n}\n\n@keyframes cxm-pulse {\n  50% {\n    box-shadow: 0 0 0 4px var(--cxm-accent-soft);\n  }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .capsule .alert {\n    animation: none;\n  }\n}\n\n.row.ref .main {\n  min-width: 0;\n}\n\n.row.news {\n  background: var(--cxm-accent-soft);\n}\n\n.ref-link {\n  color: var(--cxm-fg);\n  font-weight: 500;\n  text-decoration: none;\n  word-break: break-word;\n}\n\n.ref-link:hover {\n  color: var(--cxm-accent);\n  text-decoration: underline;\n}\n\n.asked {\n  display: -webkit-box;\n  overflow: hidden;\n  -webkit-box-orient: vertical;\n  -webkit-line-clamp: 2;\n  color: var(--cxm-muted);\n  font-size: 12px;\n}\n\n.search .results {\n  margin-top: 4px;\n}\n\ninput.search-input {\n  font-size: 12.5px;\n}\n\n/* ---------------------------------------------------------------- mainline v2 */\n\n.capsule .milestone {\n  min-width: 0;\n  max-width: 200px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--cxm-fg);\n}\n\n.tags {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 4px 6px;\n  margin: 0 0 6px;\n}\n\n.chip {\n  padding: 0 7px;\n  border-radius: 9px;\n  background: var(--cxm-hover);\n  color: var(--cxm-muted);\n  font-size: 11.5px;\n  line-height: 18px;\n}\n\n.related {\n  margin: 2px 0 6px;\n  color: var(--cxm-muted);\n  font-size: 12px;\n  cursor: pointer;\n}\n\n.related:hover {\n  color: var(--cxm-accent);\n}\n\n.milestone + .milestone,\n.milestone + input.add {\n  margin-top: 2px;\n}\n\n.milestone-mark {\n  flex: none;\n  width: 14px;\n  color: var(--cxm-faint);\n  text-align: center;\n}\n\n.milestone[data-state="done"] .milestone-mark {\n  color: var(--cxm-ok);\n}\n\n.milestone[data-state="current"] .milestone-mark {\n  color: var(--cxm-accent);\n}\n\n.milestone[data-state="current"] .milestone-title {\n  font-weight: 600;\n}\n\n.milestone[data-state="planned"] .milestone-title {\n  color: var(--cxm-muted);\n}\n\n.milestone[data-state="current"] {\n  margin: 2px -6px;\n  padding: 2px 6px 6px;\n  border-left: 2px solid var(--cxm-accent);\n  border-radius: 0 6px 6px 0;\n  background: var(--cxm-accent-soft);\n}\n\n.row.task {\n  margin-left: 14px;\n}\n\n.task-mark {\n  flex: none;\n  width: 12px;\n  color: var(--cxm-faint);\n  text-align: center;\n}\n\n.row.task[data-done="true"] .main {\n  color: var(--cxm-muted);\n}\n\n.row.task[data-done="true"] .task-mark {\n  color: var(--cxm-ok);\n}\n\n.row.task[data-doing] .main {\n  font-weight: 600;\n}\n\n.row.task[data-doing] .task-mark {\n  color: var(--cxm-accent);\n}\n\n/* The way to the child conversation carrying a task, as quiet as the text it was. */\n.row.task button.by-child {\n  color: var(--cxm-muted);\n  font-size: inherit;\n  text-align: left;\n}\n\n.row.task button.by-child:hover,\n.row.task button.by-child:focus-visible {\n  text-decoration: underline;\n}\n\n.milestone .buttons {\n  margin: 4px 0 0 14px;\n}\n\n.milestone input.add {\n  margin-left: 14px;\n  width: calc(100% - 14px);\n}\n\n.task-toggle {\n  margin-left: 20px;\n}\n\n.spinoff {\n  margin: 4px 0;\n  padding: 6px 8px;\n  border: 1px solid var(--cxm-amber-line);\n  border-radius: 8px;\n  background: var(--cxm-amber-soft);\n}\n\n.spinoff .text {\n  margin-bottom: 6px;\n  word-break: break-word;\n}\n\n.draft-form {\n  display: grid;\n  gap: 6px;\n  margin: 4px 0 8px;\n}\n\n.capsule .count {\n  font-variant-numeric: tabular-nums;\n}\n' : "";
  var CONFIRM_MS = 3e3;
  var TOAST_MS = 3500;
  var CAPSULE_HEIGHT = 30;
  var EDGE = 8;
  var BAND_MARGIN = 10;
  var MIN_BAND_WIDTH = 260;
  var SEARCH_DELAY_MS = 250;
  var TASKS_SHOWN = 8;
  var FOLD_REACHED_OVER = 4;
  var REACHED_SHOWN = 2;
  var REACHED_RUN = "reached-run";
  function splitTags(value) {
    return value.split(/[,，、]/u).map((tag) => tag.trim()).filter(Boolean);
  }
  var Capsule = class {
    constructor(options) {
      this.options = options;
      const doc = this.#doc = options.doc;
      this.#t = strings(options.locale);
      this.#h = builder(doc);
      this.host = doc.createElement("div");
      this.host.setAttribute("data-codexhost-mainline", options.surface);
      const style = this.host.style;
      style.position = "fixed";
      style.zIndex = "2147483000";
      style.transform = "translateX(-50%)";
      style.left = "50%";
      style.top = "56px";
      style.setProperty("-webkit-app-region", "no-drag");
      style.setProperty("app-region", "no-drag");
      this.#shadow = this.host.attachShadow({ mode: "open" });
      adoptStyles(this.#shadow, css);
      this.#capsule = this.#h("div", {
        class: "capsule",
        attrs: { role: "button", tabindex: "0", "aria-expanded": "false", "aria-haspopup": "dialog" }
      });
      this.#card = this.#h("div", { class: "card", attrs: { role: "dialog", "aria-label": this.#t.mainline } });
      this.#live = this.#h("div", { class: "sr-only", attrs: { role: "status", "aria-live": "polite" } });
      this.#root = this.#h("div", { class: "root", attrs: { hidden: "" } }, this.#capsule, this.#card, this.#live);
      this.#shadow.append(this.#root);
      this.#readPosition();
      this.#bind();
      this.#applyScheme();
      this.#cleanup.push(watchScheme(doc, () => this.#applyScheme()));
    }
    options;
    host;
    #doc;
    #shadow;
    #root;
    #capsule;
    #card;
    /** Says what a two-click button waits for, for screen readers. */
    #live;
    #t;
    #h;
    #cleanup = [];
    /** Two-click buttons waiting for their second click, by key; the latest button drawn for each, to calm it down. */
    #confirming = /* @__PURE__ */ new Map();
    #confirmResets = /* @__PURE__ */ new Map();
    #expanded = /* @__PURE__ */ new Set();
    #model = null;
    #threadId = null;
    #open = false;
    #flashing = false;
    #hovered = false;
    #pendingCard = false;
    #editing = null;
    #searching = false;
    #manual = null;
    #x = 0;
    #y = 0;
    #flashTimer;
    #toastTimer;
    #searchTimer;
    #toast;
    // -------------------------------------------------------------------------------------------
    // Public surface
    update(model) {
      if (model.threadId !== this.#threadId) {
        this.#threadId = model.threadId;
        this.#editing = null;
        this.#searching = false;
        this.#expanded.clear();
        for (const timer of this.#confirming.values()) clearTimeout(timer);
        this.#confirming.clear();
        this.#confirmResets.clear();
        this.#live.textContent = "";
      }
      this.#model = model;
      this.#render();
    }
    /** Opens the card for a moment, unless the user opened it or is pointing at it. */
    flash(ms = 3e3) {
      if (this.#open || !this.#model?.threadId) return;
      this.#setOpen(true, true);
      clearTimeout(this.#flashTimer);
      this.#flashTimer = setTimeout(() => this.#endFlash(), ms);
    }
    get isOpen() {
      return this.#open;
    }
    reposition() {
      const view = this.#doc.defaultView;
      if (!view) return;
      let x;
      let y;
      this.#capsule.style.maxWidth = "";
      if (this.#manual) {
        x = this.#manual.fx * view.innerWidth + (this.#capsule.offsetWidth || 160) / 2;
        y = this.#manual.y;
      } else {
        const anchor = this.options.anchor();
        x = anchor?.x ?? view.innerWidth / 2;
        y = anchor?.top ?? 56;
        const band = anchor?.band;
        const room = band ? band.right - band.left - 2 * BAND_MARGIN : 0;
        if (band && room >= MIN_BAND_WIDTH) {
          const width = Math.min(this.#capsule.offsetWidth || 160, room);
          if (width < (this.#capsule.offsetWidth || 0)) this.#capsule.style.maxWidth = `${Math.floor(room)}px`;
          x = Math.min(Math.max(x, band.left + BAND_MARGIN + width / 2), band.right - BAND_MARGIN - width / 2);
          y = band.top + Math.max(0, (band.height - CAPSULE_HEIGHT) / 2);
        }
      }
      this.#place(x, y);
    }
    destroy() {
      clearTimeout(this.#flashTimer);
      clearTimeout(this.#toastTimer);
      clearTimeout(this.#searchTimer);
      for (const timer of this.#confirming.values()) clearTimeout(timer);
      for (const stop of this.#cleanup.splice(0)) stop();
      this.host.remove();
    }
    // -------------------------------------------------------------------------------------------
    // Placement and interaction
    get #positionKey() {
      return `codexhost-mainline:position-v2:${this.options.surface}`;
    }
    #readPosition() {
      try {
        const raw = this.options.storage?.getItem(this.#positionKey);
        const parsed = raw ? JSON.parse(raw) : void 0;
        if (typeof parsed?.fx === "number" && typeof parsed.y === "number") this.#manual = { fx: parsed.fx, y: parsed.y };
      } catch {
        this.#manual = null;
      }
    }
    #savePosition() {
      const view = this.#doc.defaultView;
      if (!view) return;
      const left = this.#x - (this.#capsule.offsetWidth || 160) / 2;
      this.#manual = { fx: left / Math.max(1, view.innerWidth), y: this.#y };
      try {
        this.options.storage?.setItem(this.#positionKey, JSON.stringify(this.#manual));
      } catch {
      }
    }
    #resetPosition() {
      this.#manual = null;
      try {
        this.options.storage?.removeItem(this.#positionKey);
        this.options.storage?.removeItem(`codexhost-mainline:position:${this.options.surface}`);
      } catch {
      }
      this.reposition();
    }
    #place(x, y) {
      const view = this.#doc.defaultView;
      if (!view) return;
      const width = this.#capsule.offsetWidth || 160;
      const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
      this.#x = clamp(x, width / 2 + EDGE, view.innerWidth - width / 2 - EDGE);
      this.#y = clamp(y, EDGE, view.innerHeight - CAPSULE_HEIGHT - EDGE);
      this.host.style.left = `${Math.round(this.#x)}px`;
      this.host.style.top = `${Math.round(this.#y)}px`;
      const below = view.innerHeight - (this.#y + CAPSULE_HEIGHT + EDGE) - EDGE;
      const above = this.#y - 2 * EDGE;
      const flip = below < 240 && above > below;
      this.#root.toggleAttribute("data-flip", flip);
      this.#root.style.setProperty("--cxm-card-max", `${Math.max(160, Math.round(flip ? above : below))}px`);
    }
    #bind() {
      const capsule = this.#capsule;
      const listen = (target, type, listener, options) => {
        target.addEventListener(type, listener, options);
        this.#cleanup.push(() => target.removeEventListener(type, listener, options));
      };
      listen(capsule, "pointerdown", (event) => {
        if (event.button !== 0) return;
        const start = { x: event.clientX, y: event.clientY, left: this.#x, top: this.#y };
        let moved = false;
        try {
          capsule.setPointerCapture?.(event.pointerId);
        } catch {
        }
        const move = (next) => {
          const dx = next.clientX - start.x;
          const dy = next.clientY - start.y;
          if (!moved && Math.hypot(dx, dy) < 4) return;
          moved = true;
          this.#root.setAttribute("data-dragging", "");
          this.#place(start.left + dx, start.top + dy);
        };
        const end = () => {
          capsule.removeEventListener("pointermove", move);
          capsule.removeEventListener("pointerup", end);
          capsule.removeEventListener("pointercancel", end);
          this.#root.removeAttribute("data-dragging");
          if (moved) this.#savePosition();
          else this.#toggle();
        };
        capsule.addEventListener("pointermove", move);
        capsule.addEventListener("pointerup", end);
        capsule.addEventListener("pointercancel", end);
      });
      listen(capsule, "dblclick", () => this.#resetPosition());
      listen(capsule, "keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.#toggle();
        }
      });
      listen(this.#root, "keydown", (event) => {
        if (event.key === "Escape" && this.#open && !this.#editing && !this.#typing()) {
          event.stopPropagation();
          this.#setOpen(false);
          capsule.focus();
        }
      });
      listen(this.#root, "pointerenter", () => {
        this.#hovered = true;
      });
      listen(this.#root, "pointerleave", () => {
        this.#hovered = false;
        if (this.#flashing) {
          clearTimeout(this.#flashTimer);
          this.#flashTimer = setTimeout(() => this.#endFlash(), 800);
        }
      });
      listen(this.#card, "focusout", () => {
        setTimeout(() => {
          if (this.#pendingCard && !this.#typing()) this.#renderCard();
        }, 0);
      });
      listen(
        this.#doc,
        "pointerdown",
        (event) => {
          if (this.#open && !event.composedPath().includes(this.host)) this.#setOpen(false);
        },
        { capture: true }
      );
      const view = this.#doc.defaultView;
      if (view) listen(view, "resize", () => this.reposition());
    }
    #toggle() {
      this.#setOpen(!this.#open || this.#flashing);
    }
    #setOpen(open, flashing = false) {
      this.#open = open;
      this.#flashing = open && flashing;
      if (!open) clearTimeout(this.#flashTimer);
      this.#root.toggleAttribute("data-open", open);
      this.#capsule.setAttribute("aria-expanded", String(open));
      if (open) {
        this.#renderCard();
        this.reposition();
      } else {
        this.#editing = null;
      }
    }
    #endFlash() {
      if (!this.#flashing || this.#hovered || this.#typing()) return;
      this.#setOpen(false);
    }
    #typing() {
      return this.#shadow.activeElement?.tagName === "INPUT";
    }
    #applyScheme() {
      this.#root.setAttribute("data-scheme", detectScheme(this.#doc));
    }
    #showToast(message) {
      this.#toast?.remove();
      this.#toast = this.#h("div", { class: "toast", text: message, attrs: { role: "status" } });
      this.#root.append(this.#toast);
      clearTimeout(this.#toastTimer);
      this.#toastTimer = setTimeout(() => this.#toast?.remove(), TOAST_MS);
    }
    async #run(action) {
      try {
        await action();
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#showToast(this.#t.error(errorCodeOf(error), message));
        return false;
      }
    }
    #act(params) {
      return this.#run(() => this.options.mutate(params));
    }
    // -------------------------------------------------------------------------------------------
    // Rendering: the pill
    #render() {
      const model = this.#model;
      const visible = Boolean(model?.threadId && model.view);
      this.#root.toggleAttribute("hidden", !visible);
      if (!visible || !model?.view) {
        if (this.#open) this.#setOpen(false);
        return;
      }
      this.#renderCapsule(model.view);
      if (this.#open) this.#renderCard();
      this.reposition();
    }
    #renderCapsule(view) {
      const h = this.#h;
      const t = this.#t;
      const doc = this.#doc;
      const model = this.#model;
      const capsule = this.#capsule;
      const offline = model.offline;
      const open = view.spinoffs.filter((spinoff) => spinoff.state === "open");
      capsule.toggleAttribute("data-drift", open.length > 0 && !view.draft);
      capsule.toggleAttribute("data-empty", view.draft);
      const children2 = [];
      const tooltip = [];
      if (view.draft) {
        children2.push(
          h("span", { class: "dot", attrs: { "data-tone": "muted" } }),
          h("span", { class: "label", text: t.draftLabel }),
          h("span", { class: "goal", text: view.title })
        );
        tooltip.push(t.labelled(t.draftLabel, view.title), t.noMainline);
      } else {
        const tone = offline || view.status !== "active" ? "muted" : open.length ? "drift" : "accent";
        children2.push(h("span", { class: "dot", attrs: { "data-tone": tone } }), h("span", { class: "goal", text: view.title }));
        if (view.current) children2.push(h("span", { class: "sep" }), h("span", { class: "milestone", text: t.current(view.current.title) }));
        if (view.now) children2.push(h("span", { class: "sep" }), h("span", { class: "doing", text: `\u25B8 ${view.now.text}` }));
        else if (open.length) children2.push(h("span", { class: "sep" }), h("span", { class: "drift-text", text: `\u2442 ${open[0].text}` }));
        if (view.progress.total) children2.push(h("span", { class: "count", text: t.progress(view.progress.done, view.progress.total) }));
        tooltip.push(view.title);
        if (view.tags.length) tooltip.push(view.tags.map((tag) => `#${tag}`).join(" "));
        if (view.current) tooltip.push(t.labelled(t.milestones, view.current.title));
        if (view.now) tooltip.push(t.labelled(t.doing, view.now.text));
      }
      const news2 = model.alerts ?? [];
      capsule.toggleAttribute("data-alert", news2.length > 0);
      if (news2.length) {
        const first = news2[0];
        const label = news2.length === 1 ? t.newsOne(first.number) : t.newsMany(news2.length);
        children2.unshift(h("span", { class: "alert" }, icon(doc, "bell"), h("span", { text: label })));
        tooltip.unshift(...news2.map((ref) => `#${ref.number} ${ref.title ?? ""} \xB7 ${t.reason(ref.activity?.reason ?? "")}`));
      }
      if (offline) tooltip.unshift(t.offline);
      children2.push(icon(doc, "chevron", "chevron"));
      capsule.replaceChildren(...children2.filter((child) => child !== null));
      capsule.title = tooltip.join("\n");
      capsule.setAttribute("aria-label", t.joinParts(tooltip));
    }
    // -------------------------------------------------------------------------------------------
    // Rendering: the card
    #renderCard() {
      if (this.#typing()) {
        this.#pendingCard = true;
        return;
      }
      this.#pendingCard = false;
      const view = this.#model?.view;
      if (!view) return;
      const scroll = this.#card.scrollTop;
      this.#card.setAttribute("aria-label", this.#t.cardLabel(view.title));
      const nodes = [this.#head(view)];
      if (this.#searching && this.options.call) nodes.push(this.#searchPanel());
      const news2 = this.#model?.alerts ?? [];
      if (news2.length) nodes.push(this.#section(this.#t.news, ...news2.map((ref) => this.#refRow(ref, view.threadId, true))));
      nodes.push(...view.draft ? this.#draftBody(view) : this.#mainlineBody(view));
      this.#card.replaceChildren(...nodes);
      this.#card.scrollTop = scroll;
      const editor = this.#card.querySelector("input[data-autofocus]");
      if (editor) {
        editor.focus();
        editor.select();
      }
    }
    #head(view) {
      const h = this.#h;
      const t = this.#t;
      const label = view.draft ? t.draftLabel : `${t.mainline} \xB7 ${t.conversationStatus[view.status]}`;
      const search = this.options.call ? this.#iconButton("search", t.findConversations, () => {
        this.#searching = !this.#searching;
        this.#renderCard();
        if (this.#searching) this.#card.querySelector("input.search-input")?.focus();
      }) : null;
      return h("div", { class: "head" }, h("span", { class: "tag", text: label }), h("span", { class: "spacer" }), search, this.#closeButton());
    }
    #mainlineBody(view) {
      const h = this.#h;
      const t = this.#t;
      const threadId = view.threadId;
      const nodes = [];
      const goal = h("div", { class: "goal-line" });
      if (this.#editing === "title")
        goal.append(
          this.#editor(view.title, t.goalPlaceholder, (title) => {
            if (title) void this.#act({ op: "title", threadId, title });
          })
        );
      else
        goal.append(
          h("span", { text: view.title }),
          this.#iconButton("pencil", t.edit, () => {
            this.#editing = "title";
            this.#renderCard();
          })
        );
      nodes.push(goal);
      const tags = h("div", { class: "tags" });
      if (this.#editing === "tags")
        tags.append(
          this.#editor(view.tags.join(", "), t.tagsPlaceholder, (value) => {
            void this.#act({ op: "tags", threadId, tags: splitTags(value) });
          })
        );
      else {
        for (const tag of view.tags) tags.append(h("span", { class: "chip", text: `#${tag}` }));
        tags.append(
          h("button", {
            class: "link",
            text: view.tags.length ? t.edit : t.editTags,
            attrs: { type: "button" },
            on: {
              click: () => {
                this.#editing = "tags";
                this.#renderCard();
              }
            }
          })
        );
      }
      nodes.push(tags);
      if (view.parent) nodes.push(this.#relatedLine(t.fromParent(view.parent.title), view.parent));
      if (view.related) nodes.push(this.#relatedLine(t.linkedTo(view.related.title), view.related));
      nodes.push(this.#milestonesSection(view));
      const open = view.spinoffs.filter((spinoff) => spinoff.state === "open");
      const spawned = view.spinoffs.filter((spinoff) => spinoff.state === "spawned");
      if (open.length || spawned.length)
        nodes.push(
          this.#section(
            t.spinoffs,
            ...open.map(
              (spinoff) => h(
                "div",
                { class: "spinoff" },
                h("div", { class: "text", text: `\u2442 ${spinoff.text}` }),
                h(
                  "div",
                  { class: "buttons" },
                  this.#confirmButton(
                    `spawn:${threadId}:${spinoff.id}`,
                    t.spawnChild,
                    () => {
                      if (this.options.spawn) void this.#run(() => this.options.spawn(spinoff.id));
                    },
                    { className: "primary" }
                  ),
                  h("button", { class: "btn", text: t.keepHere, attrs: { type: "button" }, on: { click: () => void this.#act({ op: "spinoffKeep", threadId, spinoffId: spinoff.id }) } }),
                  // A dismissed spin-off cannot be brought back.
                  this.#confirmButton(`dismiss:${threadId}:${spinoff.id}`, t.dismiss, () => void this.#act({ op: "spinoffDismiss", threadId, spinoffId: spinoff.id }))
                )
              )
            ),
            ...spawned.map((spinoff) => {
              const row = h("div", { class: "row" }, h("span", { class: "muted", text: t.spawned(spinoff.text) }));
              const child = spinoff.childThreadId;
              if (child) this.#opens(row, child);
              return row;
            })
          )
        );
      if (view.children.length) nodes.push(this.#section(t.children, ...view.children.map((child) => this.#childRow(child))));
      if (view.refs.length) nodes.push(this.#section(t.windowRefs, ...view.refs.slice(0, 5).map((ref) => this.#refRow(ref, threadId, false))));
      nodes.push(
        h(
          "div",
          { class: "foot" },
          view.status === "paused" ? h("button", { class: "btn", text: t.resume, attrs: { type: "button" }, on: { click: () => void this.#act({ op: "status", threadId, status: "active" }) } }) : view.status === "active" ? h("button", { class: "btn", text: t.pause, attrs: { type: "button" }, on: { click: () => void this.#act({ op: "status", threadId, status: "paused" }) } }) : null,
          h("span", { class: "spacer" }),
          view.status === "done" ? h("button", { class: "btn", text: t.reopenMainline, attrs: { type: "button" }, on: { click: () => void this.#act({ op: "status", threadId, status: "active" }) } }) : (
            // A status, undone with "Reopen": one click.
            h("button", { class: "btn", text: t.finishMainline, attrs: { type: "button" }, on: { click: () => void this.#act({ op: "status", threadId, status: "done" }) } })
          )
        ),
        h("div", { class: "hint", text: t.overviewHint[this.options.surface] })
      );
      return nodes;
    }
    #milestonesSection(view) {
      const h = this.#h;
      const t = this.#t;
      const threadId = view.threadId;
      const rows = [];
      if (!view.milestones.length) rows.push(h("div", { class: "muted", text: t.noMilestones }));
      const leading = view.milestones.findIndex((milestone) => milestone.state !== "done");
      const reached = leading === -1 ? view.milestones.length : leading;
      const folded = reached > FOLD_REACHED_OVER && !this.#expanded.has(REACHED_RUN) ? reached - REACHED_SHOWN : 0;
      if (folded)
        rows.push(
          h("button", {
            class: "link task-toggle",
            text: t.earlierMilestones(folded),
            attrs: { type: "button" },
            on: {
              click: () => {
                this.#expanded.add(REACHED_RUN);
                this.#renderCard();
              }
            }
          })
        );
      for (const milestone of view.milestones.slice(folded)) rows.push(this.#milestoneRow(view, milestone));
      rows.push(this.#adder(t.addMilestone, (title2) => this.#act({ op: "milestoneAdd", threadId, title: title2 })));
      const title = view.progress.total ? t.counted(t.milestones, view.progress.done, view.progress.total) : t.milestones;
      return this.#section(title, ...rows);
    }
    #milestoneRow(view, milestone) {
      const h = this.#h;
      const t = this.#t;
      const now = this.#model?.now ?? Date.now();
      const threadId = view.threadId;
      const mark = milestone.state === "done" ? "\u2713" : milestone.state === "current" ? "\u25CF" : "\u25CB";
      const editing = this.#editing === `rename:${milestone.id}`;
      const titleNode = editing ? this.#editor(milestone.title, t.addMilestone, (title) => {
        if (title) void this.#act({ op: "milestoneRename", threadId, milestoneId: milestone.id, title });
      }) : h("span", { class: "milestone-title", text: milestone.title });
      const actions = h(
        "div",
        { class: "actions" },
        // Words, not a ✓: a tick here read as "done" and reopened reached milestones by mistake.
        milestone.state !== "current" ? h("button", {
          class: "link",
          text: t.makeCurrent,
          attrs: { type: "button" },
          on: {
            click: (event) => {
              event.stopPropagation();
              void this.#act({ op: "milestoneFocus", threadId, milestoneId: milestone.id });
            }
          }
        }) : null,
        this.#iconButton("pencil", t.edit, () => {
          this.#editing = `rename:${milestone.id}`;
          this.#renderCard();
        }),
        // Deleting cannot be undone: a second click within three seconds.
        this.#confirmButton(`msRemove:${threadId}:${milestone.id}`, t.remove, () => void this.#act({ op: "milestoneRemove", threadId, milestoneId: milestone.id }), { icon: "close" })
      );
      const head2 = h(
        "div",
        { class: "row milestone-row", attrs: { "data-state": milestone.state } },
        h("span", { class: "milestone-mark", text: mark }),
        h(
          "div",
          { class: "main" },
          titleNode,
          milestone.state === "done" && milestone.doneAt ? h("div", { class: "meta", text: t.time(milestone.doneAt, now) }) : null
        ),
        editing ? null : actions
      );
      const block = h("div", { class: "milestone", attrs: { "data-state": milestone.state } }, head2);
      if (milestone.state === "current") {
        const tasks = milestone.tasks.slice(-TASKS_SHOWN);
        for (const task of tasks) {
          const doing = !task.done && view.now?.text === task.text;
          const row = h(
            "div",
            { class: "row task", attrs: { "data-done": String(task.done), ...doing ? { "data-doing": "" } : {} } },
            h("span", { class: "task-mark", text: task.done ? "\u2713" : doing ? "\u25B8" : "\xB7" }),
            h(
              "div",
              { class: "main" },
              h("span", { text: task.text }),
              // The way to the child for keyboards; a click anywhere on the row opens it too.
              task.threadId && task.threadTitle ? h("button", { class: "link by-child", text: ` \xB7 ${t.byChild(task.threadTitle)}`, title: t.open, attrs: { type: "button" } }) : null
            ),
            h(
              "div",
              { class: "actions" },
              task.done ? null : this.#iconButton("check", t.complete, () => void this.#act({ op: "taskDone", threadId, taskId: task.id })),
              this.#confirmButton(`taskRemove:${threadId}:${task.id}`, t.remove, () => void this.#act({ op: "taskRemove", threadId, taskId: task.id }), { icon: "close" })
            )
          );
          if (task.threadId) {
            row.setAttribute("data-clickable", "");
            row.addEventListener("click", () => this.options.openThread(task.threadId));
          }
          block.append(row);
        }
        block.append(
          this.#adder(t.addTask, (text) => this.#act({ op: "taskAdd", threadId, text, milestoneId: milestone.id })),
          h(
            "div",
            { class: "buttons" },
            h("button", { class: "btn primary", text: t.reach, attrs: { type: "button" }, on: { click: () => void this.#act({ op: "milestoneReach", threadId, milestoneId: milestone.id }) } })
          )
        );
      } else if (milestone.tasks.length) {
        const expanded = this.#expanded.has(milestone.id);
        block.append(
          h("button", {
            class: "link task-toggle",
            text: expanded ? t.showLess : t.tasksCount(milestone.tasks.length),
            attrs: { type: "button" },
            on: {
              click: () => {
                if (expanded) this.#expanded.delete(milestone.id);
                else this.#expanded.add(milestone.id);
                this.#renderCard();
              }
            }
          })
        );
        if (expanded)
          for (const task of milestone.tasks)
            block.append(h("div", { class: "row task", attrs: { "data-done": String(task.done) } }, h("span", { class: "task-mark", text: task.done ? "\u2713" : "\xB7" }), h("div", { class: "main", text: task.text })));
      }
      return block;
    }
    #draftBody(view) {
      const h = this.#h;
      const t = this.#t;
      const title = h("input", { class: "field", attrs: { type: "text", placeholder: t.goalPlaceholder, "aria-label": t.goalPlaceholder } });
      title.value = view.title.startsWith("#") ? "" : view.title;
      const tags = h("input", { class: "field", attrs: { type: "text", placeholder: t.tagsPlaceholder, "aria-label": t.tagsPlaceholder } });
      tags.value = view.tags.join(", ");
      const plan = h("input", { class: "field", attrs: { type: "text", placeholder: t.planPlaceholder, "aria-label": t.planPlaceholder } });
      const create = () => {
        const goal = title.value.trim();
        if (!goal) {
          title.focus();
          return;
        }
        void this.#act({
          op: "create",
          threadId: view.threadId,
          title: goal,
          tags: splitTags(tags.value),
          milestones: plan.value.split("|").map((item) => item.trim()).filter(Boolean)
        });
      };
      for (const input of [title, tags, plan])
        input.addEventListener("keydown", (event) => {
          if (!event.isComposing && event.key === "Enter") {
            event.preventDefault();
            create();
          }
        });
      const nodes = [
        h("div", { class: "draft-form" }, title, tags, plan, h("div", { class: "buttons" }, h("button", { class: "btn primary", text: t.setAsMainline, attrs: { type: "button" }, on: { click: create } })))
      ];
      if (view.firstPrompt) nodes.push(h("div", { class: "asked", text: t.firstPromptLabel(view.firstPrompt) }));
      if (view.lastPrompt) nodes.push(h("div", { class: "asked", text: t.lastPromptLabel(view.lastPrompt.text) }));
      if (view.parent) nodes.push(this.#relatedLine(t.fromParent(view.parent.title), view.parent));
      if (view.children.length) nodes.push(this.#section(t.children, ...view.children.map((child) => this.#childRow(child))));
      if (view.refs.length) nodes.push(this.#section(t.windowRefs, ...view.refs.slice(0, 5).map((ref) => this.#refRow(ref, view.threadId, false))));
      nodes.push(h("div", { class: "hint", text: `${t.agentHint} ${t.overviewHint[this.options.surface]}` }));
      return nodes;
    }
    #relatedLine(text, related) {
      const row = this.#h("div", { class: "related" }, this.#h("span", { text }));
      this.#opens(row, related.threadId);
      return row;
    }
    /** A row that opens another conversation: by click, or by Enter or Space once it has the focus. */
    #opens(row, threadId) {
      row.setAttribute("data-clickable", "");
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      row.title = this.#t.open;
      row.addEventListener("click", () => this.options.openThread(threadId));
      row.addEventListener("keydown", (event) => {
        if (event.target !== row || event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        this.options.openThread(threadId);
      });
    }
    #childRow(child) {
      const h = this.#h;
      const t = this.#t;
      const row = h(
        "div",
        { class: "row" },
        h("span", { class: "status", attrs: { "data-status": child.threadStatus }, title: t.status[child.threadStatus] }),
        h(
          "div",
          { class: "main" },
          h("span", { class: "who", text: child.title }),
          child.current ? h("div", { class: "meta", text: t.current(child.current) }) : null
        ),
        child.progress ? h("span", { class: "count", text: t.progress(child.progress.done, child.progress.total) }) : null
      );
      this.#opens(row, child.threadId);
      return row;
    }
    // -------------------------------------------------------------------------------------------
    // Search and links
    #searchPanel() {
      const h = this.#h;
      const t = this.#t;
      const results = h("div", { class: "results" });
      const input = h("input", { class: "field search-input", attrs: { type: "search", placeholder: t.findConversationsPlaceholder, "aria-label": t.findConversations } });
      input.addEventListener("input", () => {
        clearTimeout(this.#searchTimer);
        const query = input.value.trim();
        this.#searchTimer = setTimeout(() => void this.#search(query, results), SEARCH_DELAY_MS);
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          this.#searching = false;
          input.blur();
          this.#renderCard();
        }
      });
      return h("div", { class: "section search" }, input, results);
    }
    async #search(query, results) {
      if (!query) {
        results.replaceChildren();
        return;
      }
      try {
        const found = await this.options.call?.("search", { query });
        const list = Array.isArray(found) ? found : [];
        results.replaceChildren(...list.length ? list.map((item) => this.#resultRow(item)) : [this.#h("div", { class: "muted", text: this.#t.noResults })]);
      } catch (error) {
        results.replaceChildren(this.#h("div", { class: "muted", text: this.#t.error(errorCodeOf(error), error instanceof Error ? error.message : String(error)) }));
      }
    }
    #resultRow(item) {
      const h = this.#h;
      const t = this.#t;
      const here = item.threadId === this.#model?.threadId;
      const meta = [
        item.draft ? t.draftLabel : null,
        item.progress.total ? t.progress(item.progress.done, item.progress.total) : null,
        item.current ? t.current(item.current) : null,
        item.tags.length ? item.tags.map((tag) => `#${tag}`).join(" ") : null
      ].filter(Boolean).join(" \xB7 ");
      return h(
        "div",
        { class: "row ref" },
        h("span", { class: "status", attrs: { "data-status": item.threadStatus } }),
        h(
          "div",
          { class: "main" },
          h("span", { class: "who", text: item.title }),
          meta ? h("div", { class: "meta", text: meta }) : null,
          h("div", { class: "asked", text: t.labelled(t.matchField[item.match.field], item.match.text) })
        ),
        here ? h("span", { class: "muted", text: t.inThisWindow }) : h("button", {
          class: "btn",
          text: t.jump,
          attrs: { type: "button" },
          on: {
            click: (event) => {
              event.stopPropagation();
              if (item.hostId) this.options.openThread(item.threadId, item.hostId);
              else this.options.openThread(item.threadId);
              this.#setOpen(false);
            }
          }
        })
      );
    }
    /** One PR or issue: what it is, where it came from, what was asked there, and a way back. */
    #refRow(ref, currentThread, isNews) {
      const h = this.#h;
      const t = this.#t;
      const now = this.#model?.now ?? Date.now();
      const origin = ref.origin;
      const here = origin?.threadId === currentThread;
      const link = h("a", {
        class: "ref-link",
        text: `#${ref.number}${ref.title ? ` ${ref.title}` : ""}`,
        title: ref.url,
        attrs: { href: ref.url, target: "_blank", rel: "noopener noreferrer" }
      });
      link.addEventListener("click", () => {
        if (isNews) void this.options.call?.("refs.seen", { key: ref.key });
      });
      const meta = [
        isNews && ref.activity ? `${t.reason(ref.activity.reason)} \xB7 ${t.time(ref.activity.at, now)}` : null,
        `${t.kind[ref.kind]}${ref.state ? ` \xB7 ${t.refState[ref.state]}` : ""}`,
        ref.repo,
        origin ? (here ? t.inThisWindow : t.fromWindow(origin.title ?? origin.threadId.slice(0, 8))) + (origin.turn ? ` ${t.turn(origin.turn)}` : "") : null
      ].filter(Boolean).join(" \xB7 ");
      const jump = origin && !here ? h("button", {
        class: "btn",
        text: t.jump,
        attrs: { type: "button" },
        on: {
          click: (event) => {
            event.stopPropagation();
            void this.options.call?.("refs.seen", { key: ref.key });
            if (origin.hostId) this.options.openThread(origin.threadId, origin.hostId);
            else this.options.openThread(origin.threadId);
            this.#setOpen(false);
          }
        }
      }) : null;
      return h(
        "div",
        { class: `row ref${isNews ? " news" : ""}` },
        icon(this.#doc, isNews ? "bell" : "open", "mark"),
        h(
          "div",
          { class: "main" },
          link,
          h("div", { class: "meta", text: meta }),
          origin?.prompt ? h("div", { class: "asked", text: t.asked(origin.prompt) }) : null,
          ref.note ? h("div", { class: "asked", text: t.noteLabel(ref.note) }) : null
        ),
        jump
      );
    }
    // -------------------------------------------------------------------------------------------
    // Small builders
    #closeButton() {
      return this.#iconButton("close", this.#t.collapse, () => this.#setOpen(false));
    }
    #iconButton(name, label, onClick) {
      const button = this.#h("button", {
        class: "icon",
        title: label,
        attrs: { type: "button", "aria-label": label },
        on: {
          click: (event) => {
            event.stopPropagation();
            onClick();
          }
        }
      });
      button.append(icon(this.#doc, name));
      return button;
    }
    /**
     * A button that acts on a second click within three seconds, for what cannot be undone. The armed
     * state lives outside the button, so a redraw of the card in between keeps it; screen readers hear
     * that it waits. An icon button shows its words while it waits.
     */
    #confirmButton(key, label, onConfirm, options = {}) {
      const button = this.#h("button", { title: label, attrs: { type: "button" } });
      const idle = () => {
        button.removeAttribute("data-confirm");
        if (options.icon) {
          button.className = "icon";
          button.setAttribute("aria-label", label);
          button.replaceChildren(icon(this.#doc, options.icon));
        } else {
          button.className = `btn ${options.className ?? ""}`.trim();
          button.textContent = label;
        }
      };
      const armed = () => {
        button.setAttribute("data-confirm", "");
        button.className = `btn ${options.icon ? "" : options.className ?? ""}`.trim();
        button.removeAttribute("aria-label");
        button.textContent = this.#t.confirm;
      };
      if (this.#confirming.has(key)) armed();
      else idle();
      this.#confirmResets.set(key, idle);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const waiting = this.#t.armed(label);
        const timer = this.#confirming.get(key);
        if (timer !== void 0) {
          clearTimeout(timer);
          this.#confirming.delete(key);
          if (this.#live.textContent === waiting) this.#live.textContent = "";
          idle();
          onConfirm();
          return;
        }
        this.#confirming.set(
          key,
          setTimeout(() => {
            this.#confirming.delete(key);
            if (this.#live.textContent === waiting) this.#live.textContent = "";
            this.#confirmResets.get(key)?.();
          }, CONFIRM_MS)
        );
        armed();
        this.#live.textContent = waiting;
      });
      return button;
    }
    /** An inline editor: Enter or leaving the field saves, Escape cancels. */
    #editor(value, placeholder, save) {
      const input = this.#h("input", { class: "field", attrs: { type: "text", placeholder, "data-autofocus": "", "aria-label": placeholder } });
      input.value = value;
      let settled = false;
      const finish = (commit) => {
        if (settled) return;
        settled = true;
        this.#editing = null;
        const text = input.value.trim();
        if (commit && text !== value.trim()) save(text);
        else this.#renderCard();
      };
      input.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      });
      input.addEventListener("blur", () => finish(true));
      return input;
    }
    /** A dashed "add" field that stays put for several entries in a row. */
    #adder(placeholder, add) {
      const input = this.#h("input", { class: "field add", attrs: { type: "text", placeholder, "aria-label": placeholder } });
      input.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          input.value = "";
          void add(text);
        } else if (event.key === "Escape") {
          event.stopPropagation();
          input.value = "";
          input.blur();
        }
      });
      return input;
    }
    #section(title, ...children2) {
      return this.#h("div", { class: "section" }, this.#h("div", { class: "section-title", text: title }), ...children2);
    }
  };

  // src/ui/controller.ts
  var POLL_MS = 2e3;
  var MAX_BACKOFF_MS = 3e4;
  var FLASH_MS = 3e3;
  var DIAGNOSE_EVERY_MS = 5e3;
  function safeStorage(view) {
    try {
      return view?.localStorage ?? null;
    } catch {
      return null;
    }
  }
  var DEBUG_KEY = "codexhost-mainline:debug";
  function diagnosticsOn(view) {
    try {
      return safeStorage(view ?? null)?.getItem(DEBUG_KEY) === "1";
    } catch {
      return false;
    }
  }
  function clientId(view) {
    try {
      const uuid = (view?.crypto ?? globalThis.crypto)?.randomUUID?.();
      if (uuid) return uuid;
    } catch {
    }
    return `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12).padEnd(10, "0")}`;
  }
  function hostParams(adapter, threadId) {
    const hostId = threadId ? adapter.hostOf?.(threadId) : void 0;
    return hostId ? { hostId } : {};
  }
  function startController(adapter) {
    const doc = adapter.doc;
    const view = doc.defaultView;
    const locale = localeOf(doc.documentElement.lang || view?.navigator.language);
    const client = clientId(view);
    let data = null;
    let current = null;
    let loaded = null;
    let loading = null;
    let flashWanted = false;
    let offline = false;
    let failures = 0;
    let timer;
    let polling;
    let again = false;
    let disposed = false;
    let localeSent = false;
    const listeners = /* @__PURE__ */ new Set();
    let lastDiagnosis = "";
    let lastDiagnosisAt = 0;
    const diagnose = () => {
      if (!adapter.describe || disposed || !diagnosticsOn(view)) return;
      let text;
      try {
        text = JSON.stringify({ ...adapter.describe(), capsule: capsuleBox() });
      } catch {
        return;
      }
      if (text === lastDiagnosis || Date.now() - lastDiagnosisAt < DIAGNOSE_EVERY_MS) return;
      lastDiagnosis = text;
      lastDiagnosisAt = Date.now();
      void adapter.invoke("diagnose", { surface: adapter.surface, report: JSON.parse(text) }).catch(() => void 0);
    };
    const capsuleBox = () => {
      const host = doc.querySelector("[data-codexhost-mainline]");
      const capsuleElement = host?.shadowRoot?.querySelector(".capsule");
      const rect = capsuleElement?.getBoundingClientRect();
      return rect && rect.width > 0 ? [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width)] : null;
    };
    let capsule = null;
    let unmount;
    const capsuleWanted = (want) => {
      if (want && !capsule) {
        capsule = new Capsule({
          doc,
          locale,
          surface: adapter.surface,
          mutate: async (params) => {
            await adapter.invoke("mutate", { ...params, ...hostParams(adapter, params.threadId) });
            await refresh();
          },
          spawn: async (spinoffId) => {
            if (!current) return;
            await adapter.invoke("spawn", { threadId: current, spinoffId, ...hostParams(adapter, current) });
            await refresh();
          },
          openThread: (threadId, hostId) => hostId ? adapter.openThread(threadId, hostId) : adapter.openThread(threadId),
          call: (method, params) => adapter.invoke(method, params),
          anchor: () => adapter.anchor(),
          storage: safeStorage(view)
        });
        unmount = adapter.mount(capsule.host);
      } else if (!want && capsule) {
        capsule.destroy();
        unmount?.();
        capsule = null;
        unmount = void 0;
      }
      return capsule;
    };
    const render = () => {
      const shown = capsuleWanted(Boolean(data?.settings.showCapsule));
      if (!shown) return;
      const viewFor = loaded && loaded.threadId === current ? loaded.view : null;
      shown.update({
        // Stay hidden until the first state and the conversation's view arrive, so nothing flickers.
        threadId: data ? current : null,
        view: viewFor,
        settings: data?.settings ?? DEFAULT_SETTINGS,
        offline,
        now: Date.now(),
        alerts: data?.alerts ?? []
      });
    };
    const loadView = async () => {
      const threadId = current;
      const version = data?.version;
      if (!threadId || !version) return;
      if (loaded?.threadId === threadId && loaded.version === version) return;
      const key = `${threadId}|${version}`;
      if (loading === key) return;
      loading = key;
      try {
        const next = await adapter.invoke("conversation", { threadId, ...hostParams(adapter, threadId) });
        if (disposed || current !== threadId) return;
        loaded = { threadId, version, view: next };
        render();
        if (flashWanted) {
          flashWanted = false;
          if (!next.draft && next.status === "active") capsule?.flash(FLASH_MS);
        }
      } catch {
      } finally {
        if (loading === key) loading = null;
      }
    };
    const schedule = (ms) => {
      clearTimeout(timer);
      if (!disposed) timer = setTimeout(() => void refresh(), ms);
    };
    const pollOnce = async () => {
      const params = {
        client,
        ...data ? { version: data.version } : {},
        ...current ? { focus: { threadId: current, surface: adapter.surface, ...hostParams(adapter, current) } } : {},
        ...localeSent ? {} : { locale, localeSource: "surface" }
      };
      try {
        const result = await adapter.invoke("snapshot", params);
        localeSent = true;
        failures = 0;
        const wasOffline = offline;
        offline = false;
        if (result.state) {
          data = {
            state: result.state,
            info: result.info ?? {},
            settings: result.settings ?? DEFAULT_SETTINGS,
            version: result.version,
            alerts: result.alerts ?? [],
            parents: result.parents ?? {},
            hosts: result.hosts ?? {},
            ...result.command ? { command: result.command } : {},
            ...result.reveal ? { reveal: result.reveal } : {}
          };
          adapter.onData?.(data, current);
          render();
          for (const listener of [...listeners]) {
            try {
              listener(result.version, data);
            } catch {
            }
          }
        } else if (wasOffline) render();
        else capsule?.reposition();
        await loadView();
        diagnose();
      } catch {
        if (disposed) return;
        failures += 1;
        if (!offline) {
          offline = true;
          render();
        }
      }
    };
    async function refresh() {
      if (disposed) return;
      if (polling) {
        again = true;
        return polling;
      }
      if (doc.visibilityState === "hidden") {
        clearTimeout(timer);
        return;
      }
      polling = pollOnce().finally(() => {
        polling = void 0;
      });
      await polling;
      if (again && !disposed) {
        again = false;
        return refresh();
      }
      schedule(failures ? Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** failures) : POLL_MS);
    }
    const stopWatching = adapter.watchCurrentThread((threadId) => {
      if (threadId === current) return;
      const previous = current;
      current = threadId;
      flashWanted = previous !== null && threadId !== null;
      render();
      void loadView();
      void refresh();
    });
    const onVisibility = () => {
      if (doc.visibilityState === "visible") void refresh();
    };
    doc.addEventListener("visibilitychange", onVisibility);
    void refresh();
    return {
      refresh,
      current: () => current,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose() {
        disposed = true;
        listeners.clear();
        clearTimeout(timer);
        stopWatching();
        doc.removeEventListener("visibilitychange", onVisibility);
        capsuleWanted(false);
        adapter.dispose?.();
      }
    };
  }

  // src/ui/hover/strings.ts
  var HOST_STATES_ZH = { connected: "\u5DF2\u8FDE\u63A5", connecting: "\u8FDE\u63A5\u4E2D", "auth-error": "\u8BA4\u8BC1\u5931\u8D25", offline: "\u79BB\u7EBF", disabled: "\u5DF2\u505C\u7528", unknown: "\u72B6\u6001\u672A\u77E5" };
  var HOST_STATES_EN = { connected: "Connected", connecting: "Connecting", "auth-error": "Auth error", offline: "Offline", disabled: "Disabled", unknown: "State unknown" };
  var REASONS_ZH = {
    comment: "\u6709\u65B0\u8BC4\u8BBA",
    review: "\u6709\u65B0\u8BC4\u5BA1",
    approved: "\u8BC4\u5BA1\u901A\u8FC7",
    changes_requested: "\u8981\u6C42\u4FEE\u6539",
    merged: "\u5DF2\u5408\u5E76",
    review_requested: "\u8BF7\u4F60 review",
    mention: "\u63D0\u5230\u4E86\u4F60",
    state_change: "\u72B6\u6001\u53D8\u4E86",
    assign: "\u6307\u6D3E\u7ED9\u4F60",
    ci_activity: "CI \u6709\u7ED3\u679C",
    team_mention: "\u63D0\u5230\u4E86\u4F60\u7684\u56E2\u961F"
  };
  var REASONS_EN = {
    comment: "New comment",
    review: "New review",
    approved: "Approved",
    changes_requested: "Changes requested",
    merged: "Merged",
    review_requested: "Review requested",
    mention: "You were mentioned",
    state_change: "State changed",
    assign: "Assigned to you",
    ci_activity: "CI finished",
    team_mention: "Your team was mentioned"
  };
  function relative2(at, now, locale) {
    const zh4 = locale === "zh-CN";
    const minutes = Math.round((now - at) / 6e4);
    if (minutes < 1) return zh4 ? "\u521A\u521A" : "just now";
    if (minutes < 60) return zh4 ? `${minutes} \u5206\u949F\u524D` : `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return zh4 ? `${hours} \u5C0F\u65F6\u524D` : `${hours} h ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return zh4 ? `${days} \u5929\u524D` : `${days} d ago`;
    const date = new Date(at);
    return zh4 ? `${date.getMonth() + 1}\u6708${date.getDate()}\u65E5` : date.toLocaleDateString("en", { month: "short", day: "numeric" });
  }
  var plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  var zh2 = {
    locale: "zh-CN",
    draft: "\u672A\u51DD\u7EC3",
    draftTip: "\u8FD8\u6CA1\u6709\u4E3B\u7EBF\uFF1A\u6807\u9898\u3001\u6807\u7B7E\u548C\u8D77\u56E0\u6682\u53D6\u81EA\u5BF9\u8BDD\u6807\u9898\u3001\u5DE5\u4F5C\u533A\u3001\u63D0\u5230\u7684 PR \u548C\u7B2C\u4E00\u53E5\u8BDD\u3002\u5F00\u7740\u81EA\u52A8\u51DD\u7EC3\u65F6\uFF0C\u5BF9\u8BDD\u6709\u65B0\u56DE\u590D\u540E\u4E00\u4E24\u5206\u949F\u5185\u4F1A\u81EA\u52A8\u51DD\u7EC3\uFF1B\u4E5F\u53EF\u4EE5\u70B9\u300C\u7ACB\u5373\u51DD\u7EC3\u300D\u3002",
    status: { active: "\u8FDB\u884C\u4E2D", paused: "\u6682\u505C", done: "\u5B8C\u6210" },
    live: { running: "\u8FD0\u884C\u4E2D", waiting: "\u7B49\u4F60\u5904\u7406", idle: "\u7A7A\u95F2", unknown: "\u72B6\u6001\u672A\u77E5" },
    milestones: "\u91CC\u7A0B\u7891",
    noMilestones: "\u8FD8\u6CA1\u6709\u8BB0\u5F55\u91CC\u7A0B\u7891",
    doing: "\u6B63\u5728\u505A",
    inChild: (title) => `\u5B50\u5BF9\u8BDD\u300C${title}\u300D`,
    earlierMilestones: (count) => `\u8FD8\u6709 ${count} \u4E2A\u66F4\u65E9\u7684\u91CC\u7A0B\u7891`,
    earlierTasks: (count) => `\u8FD8\u6709 ${count} \u9879\u5DF2\u5B8C\u6210`,
    children: (count) => `\u5B50\u5BF9\u8BDD\uFF08${count}\uFF09`,
    moreChildren: (count) => `\u8FD8\u6709 ${count} \u4E2A\u5B50\u5BF9\u8BDD`,
    from: "\u6765\u81EA\uFF1A",
    related: "\u5173\u8054\uFF1A",
    refs: "PR \u4E0E Issue",
    moreRefs: (count) => `\u8FD8\u6709 ${count} \u4E2A`,
    kind: { pr: "PR", issue: "Issue" },
    refState: { open: "\u8FDB\u884C\u4E2D", closed: "\u5DF2\u5173\u95ED", merged: "\u5DF2\u5408\u5E76", unknown: "\u72B6\u6001\u5F85\u786E\u8BA4" },
    origin: "\u8D77\u56E0\uFF1A",
    lastPrompt: "\u6700\u8FD1\u8BF7\u6C42\uFF1A",
    loading: "\u6B63\u5728\u8BFB\u53D6\u2026",
    failed: (message) => `\u8BFB\u53D6\u5931\u8D25\uFF1A${message}`,
    noThread: "\u627E\u4E0D\u5230\u8FD9\u4E2A\u5BF9\u8BDD",
    badResponse: "\u540E\u53F0\u8FD4\u56DE\u7684\u6570\u636E\u65E0\u6CD5\u8BC6\u522B",
    open: (title) => `\u6253\u5F00\u300C${title}\u300D`,
    spinoffs: "\u5F15\u7533\u95EE\u9898",
    spawnChild: "\u5F00\u5B50\u5BF9\u8BDD",
    newChild: "\uFF0B \u5F00\u5B50\u5BF9\u8BDD",
    newChildHint: "\u65B0\u95EE\u9898\u4E00\u53E5\u8BDD\uFF0C\u4F8B\u5982\uFF1A\u89C6\u9891\u70B9\u4E0D\u5F00",
    confirm: "\u518D\u70B9\u4E00\u6B21\u786E\u8BA4",
    cancel: "\u53D6\u6D88",
    spawning: "\u6B63\u5728\u5F00\u5B50\u5BF9\u8BDD\u2026",
    spawned: (title) => `\u5DF2\u5F00\u5B50\u5BF9\u8BDD\u300C${title}\u300D`,
    spawnFailed: (message) => `\u6CA1\u6709\u5F00\u6210\uFF1A${message}`,
    spawnPending: "\u6B63\u5728\u6253\u5F00\u5B50\u5BF9\u8BDD\uFF1Acodexhost \u8FD8\u6CA1\u7B54\u590D\uFF0C\u5F00\u597D\u540E\u4F1A\u51FA\u73B0\u5728\u672C\u5BF9\u8BDD\u4E0B\u65B9\uFF0C\u5148\u4E0D\u8981\u518D\u70B9",
    armed: (label) => `${label}\uFF1A3 \u79D2\u5185\u518D\u70B9\u4E00\u6B21\u786E\u8BA4`,
    openIt: "\u6253\u5F00",
    news: "PR \u4E0E Issue \u65B0\u52A8\u6001",
    reason: (reason) => REASONS_ZH[reason] ?? "\u6709\u65B0\u52A8\u6001",
    seen: "\u77E5\u9053\u4E86",
    summary: (count) => `${count} \u6761 PR \u4E0E Issue \u65B0\u52A8\u6001`,
    summaryTip: (count) => `${count} \u6761 PR \u4E0E Issue \u65B0\u52A8\u6001\uFF0C\u5B83\u4EEC\u6240\u5728\u7684\u5BF9\u8BDD\u5728\u4FA7\u680F\u91CC\u770B\u4E0D\u5230\uFF08\u5728\u6536\u8D77\u7684\u5206\u7EC4\u91CC\u3001\u6EDA\u51FA\u4E86\u5217\u8868\u6216\u6CA1\u6709\u5217\u51FA\uFF09`,
    openConversation: "\u6253\u5F00\u5BF9\u8BDD",
    fromConversation: (title, turn) => turn > 0 ? `\u6765\u81EA\u5BF9\u8BDD\u300C${title}\u300D\u7B2C ${turn} \u8F6E` : `\u6765\u81EA\u5BF9\u8BDD\u300C${title}\u300D`,
    summarized: (time) => `\u6A21\u578B\u51DD\u7EC3 \xB7 ${time}`,
    resummarize: "\u21BB \u91CD\u65B0\u51DD\u7EC3",
    summarizeNow: "\u21BB \u7ACB\u5373\u51DD\u7EC3",
    summarizing: "\u51DD\u7EC3\u4E2D\u2026",
    noSummarizer: "\u6CA1\u6709\u51DD\u7EC3\uFF1A\u6309\u8BBE\u7F6E\uFF0CClaude Code \u548C Codex \u4EE5\u5916\u7684 Agent \u7684\u5BF9\u8BDD\u4E0D\u53D1\u7ED9\u6A21\u578B\u3002\u8981\u51DD\u7EC3\uFF0C\u8BF7\u5728\u603B\u89C8\u9875\u300C\u8BBE\u7F6E\u300D\u91CC\u4E3A\u300C\u5176\u4ED6 Agent\uFF08\u5982 pi\u3001DeepSeek\u3001Grok\uFF09\u7684\u5BF9\u8BDD\u300D\u9009\u4E00\u4E2A\u6A21\u578B\u3002",
    attach: "\u6DFB\u52A0\u7167\u7247\u3001\u6587\u4EF6\u6216\u89C6\u9891",
    attachTip: "\u6DFB\u52A0\u7167\u7247\u3001\u6587\u4EF6\u6216\u89C6\u9891\uFF1B\u4E5F\u53EF\u4EE5\u7C98\u8D34\u622A\u56FE\uFF0C\u6216\u628A\u6587\u4EF6\u62D6\u8FDB\u5361\u7247",
    detach: (name) => `\u79FB\u9664\u300C${name}\u300D`,
    uploading: (percent) => `\u6B63\u5728\u4E0A\u4F20\u9644\u4EF6 ${percent}%`,
    dropHere: "\u677E\u5F00\u5373\u53EF\u6DFB\u52A0\u9644\u4EF6",
    tooLarge: (name, limit) => `\u300C${name}\u300D\u8D85\u8FC7 ${limit}\uFF0C\u6CA1\u6709\u52A0\u4E0A`,
    tooMany: (count) => `\u6700\u591A\u9644\u5E26 ${count} \u4E2A\u6587\u4EF6`,
    tooMuch: (limit) => `\u9644\u4EF6\u5408\u8BA1\u4E0D\u80FD\u8D85\u8FC7 ${limit}`,
    host: (name, state) => `${name ?? "\u53E6\u4E00\u53F0\u7535\u8111"} \xB7 ${HOST_STATES_ZH[state]}`,
    hostTip: "\u8FD9\u4E2A\u5BF9\u8BDD\u5728\u53E6\u4E00\u53F0\u7535\u8111\u4E0A\uFF08codexhost Web \u8FDE\u63A5\u7684\u8FDC\u7A0B\u4E3B\u673A\uFF09\uFF0C\u7ECF\u672C\u673A\u7684 codexhost \u8BFB\u53D6\uFF0C\u5728\u672C\u673A\u51DD\u7EC3",
    remoteFiles: "\u8FD9\u4E2A\u5BF9\u8BDD\u5728\u53E6\u4E00\u53F0\u7535\u8111\u4E0A\uFF0C\u5B50\u5BF9\u8BDD\u4E5F\u5F00\u5728\u90A3\u91CC\uFF0C\u90A3\u53F0\u7535\u8111\u8BFB\u4E0D\u5230\u672C\u673A\u7684\u6587\u4EF6\uFF0C\u6240\u4EE5\u4E0D\u80FD\u9644\u5E26\u7167\u7247\u3001\u6587\u4EF6\u6216\u89C6\u9891",
    time: (at, now) => relative2(at, now, "zh-CN"),
    date: (at) => new Date(at).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })
  };
  var en2 = {
    locale: "en",
    draft: "Not summarized",
    draftTip: "No mainline yet: the title, tags and origin come from the conversation's title, workspace, the PRs it mentions and its first message. With automatic summaries on, a model summarizes it a minute or two after a new reply; or click Summarize now.",
    status: { active: "Active", paused: "Paused", done: "Done" },
    live: { running: "Running", waiting: "Needs you", idle: "Idle", unknown: "Unknown" },
    milestones: "Milestones",
    noMilestones: "No milestones yet",
    doing: "Doing",
    inChild: (title) => `In child "${title}"`,
    earlierMilestones: (count) => plural(count, "earlier milestone"),
    earlierTasks: (count) => `${count} more done`,
    children: (count) => `Child conversations (${count})`,
    moreChildren: (count) => `${count} more`,
    from: "From:",
    related: "Linked to:",
    refs: "PRs and issues",
    moreRefs: (count) => `${count} more`,
    kind: { pr: "PR", issue: "Issue" },
    refState: { open: "Open", closed: "Closed", merged: "Merged", unknown: "Status unknown" },
    origin: "Started with:",
    lastPrompt: "Last request:",
    loading: "Loading\u2026",
    failed: (message) => `Could not load: ${message}`,
    noThread: "This conversation was not found",
    badResponse: "The backend sent something unexpected",
    open: (title) => `Open "${title}"`,
    spinoffs: "Spin-offs",
    spawnChild: "Open child",
    newChild: "+ Child conversation",
    newChildHint: "The new problem in one line",
    confirm: "Click again to confirm",
    cancel: "Cancel",
    spawning: "Opening the child conversation\u2026",
    spawned: (title) => `Opened child conversation "${title}"`,
    spawnFailed: (message) => `Could not open it: ${message}`,
    spawnPending: "Opening the child conversation: no answer from codexhost yet; it shows up under this conversation once it opens",
    armed: (label) => `${label}: click again within 3 seconds to confirm`,
    openIt: "Open",
    news: "PR and issue news",
    reason: (reason) => REASONS_EN[reason] ?? "New activity",
    seen: "Got it",
    summary: (count) => `${count} new on your PRs and issues`,
    summaryTip: (count) => `${count} new on your PRs and issues, from conversations the sidebar does not show (in a collapsed group, scrolled away, or not listed)`,
    openConversation: "Open conversation",
    fromConversation: (title, turn) => turn > 0 ? `From "${title}", turn ${turn}` : `From "${title}"`,
    summarized: (time) => `Summarized ${time}`,
    resummarize: "\u21BB Summarize again",
    summarizeNow: "\u21BB Summarize now",
    summarizing: "Summarizing\u2026",
    noSummarizer: "Not summarized: the settings send no conversation of an agent other than Claude Code and Codex to a model. To summarize it, choose a model under \u201CConversations of other agents (pi, DeepSeek, Grok, \u2026)\u201D in the overview's Settings tab.",
    attach: "Add photos, files or videos",
    attachTip: "Add photos, files or videos. You can also paste a screenshot or drop files on the card.",
    detach: (name) => `Remove "${name}"`,
    uploading: (percent) => `Uploading ${percent}%`,
    dropHere: "Drop to attach",
    tooLarge: (name, limit) => `"${name}" is over ${limit} and was left out`,
    tooMany: (count) => `At most ${count} files`,
    tooMuch: (limit) => `Attachments may add up to ${limit} at most`,
    host: (name, state) => `${name ?? "Another computer"} \xB7 ${HOST_STATES_EN[state]}`,
    hostTip: "This conversation is on another computer (a remote host connected to codexhost Web); it is read through codexhost on this machine and summarized here",
    remoteFiles: "This conversation is on another computer, where the child opens too, and that computer cannot read files on this one, so no photos, files or videos can go along",
    time: (at, now) => relative2(at, now, "en"),
    date: (at) => new Date(at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })
  };
  function hoverStrings(locale) {
    return locale === "zh-CN" ? zh2 : en2;
  }
  function hoverLocale(doc) {
    return localeOf(doc.documentElement.lang || doc.defaultView?.navigator.language);
  }

  // src/core/favorites.ts
  var ANNOTATION = /:{1,2}codex-annotation\{[^}]*\}[ \t]*/gu;
  function cleanPassage(text) {
    return text.replace(ANNOTATION, "").trim();
  }
  function skeleton(text) {
    let out = "";
    const source = text.replace(ANNOTATION, "").replace(/^\s*(?:```|~~~)[^\n]*$/gmu, "").replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1");
    for (const char of source) if (KEPT.test(char)) out += char.toLowerCase();
    return out;
  }
  var KEPT = /[\p{L}\p{N}]/u;
  var NEEDLE_MIN = 6;
  var NEEDLE_MAX = 40;
  function needlesOf(text, count = 3) {
    const lines = cleanPassage(text).split(/\n+/u).map((line) => skeleton(line)).filter((line) => line.length >= NEEDLE_MIN).sort((a, b) => b.length - a.length).map((line) => line.slice(0, NEEDLE_MAX));
    const whole = skeleton(text);
    if (!lines.length && whole.length >= NEEDLE_MIN) lines.push(whole.slice(0, NEEDLE_MAX));
    return [...new Set(lines)].slice(0, count);
  }

  // src/ui/favorites/find.ts
  var MESSAGE_SELECTOR = "[data-chat-flow-kind], [data-turn-key], [data-content-search-turn-key], [data-message-id], [data-message-author-role]";
  var EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]';
  var elementOf = (node) => !node ? null : node.nodeType === 1 ? node : node.parentElement;
  function messageOf(node) {
    const element = elementOf(node);
    if (!element || element.closest(EDITABLE)) return null;
    return element.closest(MESSAGE_SELECTOR);
  }
  function roleOf(node) {
    const holder = elementOf(node)?.closest("[data-message-author-role], [data-chat-flow-kind]");
    const value = (holder?.getAttribute("data-message-author-role") ?? holder?.getAttribute("data-chat-flow-kind") ?? "").toLowerCase();
    if (value.includes("user")) return "user";
    if (value.includes("assistant") || value.includes("agent")) return "agent";
    return void 0;
  }
  function messageRoots(doc) {
    return [...doc.querySelectorAll(MESSAGE_SELECTOR)].filter((element) => !element.parentElement?.closest(MESSAGE_SELECTOR));
  }
  function textMap(doc) {
    let text = "";
    const spots = [];
    for (const root of messageRoots(doc)) {
      const walker = doc.createTreeWalker(
        root,
        4
        /* NodeFilter.SHOW_TEXT */
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (parent && (parent.closest("style, script, noscript") || parent.closest(EDITABLE))) continue;
        const value = node.data;
        let offset = 0;
        for (const char of value) {
          const end = offset + char.length;
          if (KEPT.test(char))
            for (const unit of char.toLowerCase()) {
              text += unit;
              spots.push({ node, start: offset, end });
            }
          offset = end;
        }
      }
    }
    return { text, spots };
  }
  var FULL_MAX = 4e3;
  var FULL_MIN = 4;
  var EDGE2 = 40;
  function findPassage(doc, passage) {
    const { text, spots } = textMap(doc);
    if (!text) return null;
    const whole = skeleton(passage);
    let start = -1;
    let end = -1;
    if (whole.length >= FULL_MIN && whole.length <= FULL_MAX) {
      start = text.indexOf(whole);
      if (start >= 0) end = start + whole.length;
    }
    if (start < 0) {
      let anchor = -1;
      let needle = "";
      for (const candidate of needlesOf(passage)) {
        anchor = text.indexOf(candidate);
        if (anchor >= 0) {
          needle = candidate;
          break;
        }
      }
      if (anchor < 0) return null;
      start = anchor;
      end = anchor + needle.length;
      const lines = cleanPassage(passage).split(/\n+/u).map((line) => skeleton(line)).filter((line) => line.length >= 2);
      const first = lines[0]?.slice(0, EDGE2);
      const last = lines[lines.length - 1]?.slice(-EDGE2);
      if (first) {
        const at = text.indexOf(first, Math.max(0, anchor - whole.length - 200));
        if (at >= 0 && at <= anchor) start = at;
      }
      if (last) {
        const at = text.indexOf(last, anchor);
        if (at >= 0 && at - anchor <= whole.length * 1.5 + 400) end = Math.max(end, at + last.length);
      }
    }
    const from = spots[start];
    const to = spots[end - 1];
    if (!from || !to) return null;
    const range = doc.createRange();
    range.setStart(from.node, from.start);
    range.setEnd(to.node, to.end);
    return range;
  }
  function scrollerOf(element) {
    const view = element?.ownerDocument.defaultView;
    for (let node = element?.parentElement ?? null; node && view; node = node.parentElement) {
      const overflow = view.getComputedStyle(node).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight + 4) return node;
    }
    return null;
  }

  // src/ui/favorites/index.ts
  var HOST_ATTRIBUTE = "data-codexhost-mainline-favorites";
  var HIGHLIGHT_NAME = "codexhost-mainline-favorite";
  var SETTLE_MS = 180;
  var REPLACE_MS = [120, 360];
  var FEEDBACK_MS = 1400;
  var FAILED_MS = 2600;
  var HIGHLIGHT_MS = 12e3;
  var TOAST_MS2 = 3200;
  var REVEAL_FOR_MS = 16e3;
  var REVEAL_EVERY_MS = 450;
  var REVEAL_SCROLL_AFTER_MS = 1800;
  var REVEAL_SCROLLS = 14;
  var GAP = 6;
  var MARGIN = 8;
  var MIN_CHARS = 2;
  var zh3 = {
    save: "\u6536\u85CF",
    saving: "\u6536\u85CF\u4E2D\u2026",
    saved: "\u5DF2\u6536\u85CF",
    again: "\u5DF2\u6536\u85CF\u8FC7",
    failed: (reason) => `\u6536\u85CF\u5931\u8D25\uFF1A${reason}`,
    full: "\u6536\u85CF\u5DF2\u6EE1\uFF0C\u8BF7\u5728\u603B\u89C8\u9875\u5220\u9664\u4E0D\u7528\u7684\u6536\u85CF",
    busy: "\u6B63\u5728\u5199\u5165\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5",
    cause: (code, message) => strings("zh-CN").error(code, message),
    title: "\u6536\u85CF\u8FD9\u6BB5\uFF1A\u5728\u300C\u7B2C\u4E8C\u5927\u8111\u300D\u9875\u9762\u7684\u300C\u6536\u85CF\u300D\u9875\u7B7E\u91CC\u53EF\u4EE5\u627E\u5230",
    notFound: "\u6CA1\u5728\u5BF9\u8BDD\u91CC\u627E\u5230\u8FD9\u6BB5\u539F\u6587\uFF0C\u5B83\u53EF\u80FD\u5728\u5F88\u65E9\u7684\u8F6E\u6B21\uFF0C\u6216\u5DF2\u88AB\u6539\u52A8"
  };
  var en3 = {
    save: "Save",
    saving: "Saving\u2026",
    saved: "Saved",
    again: "Saved before",
    failed: (reason) => `Could not save: ${reason}`,
    full: "the saved passages are full; delete some in the overview",
    busy: "busy; try again in a moment",
    cause: (code, message) => strings("en").error(code, message),
    title: "Save this passage: find it in the Favorites tab of the Second Brain page",
    notFound: "The saved passage is not in this conversation on screen; it may be in a very early turn, or changed"
  };
  function failureReason(t, error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = errorCodeOf(error);
    const reason = code === "FAVORITES_FULL" ? t.full : code === "LOCKED" ? t.busy : isErrorCode(code) ? t.cause(code, message) : errorDetail(message);
    const chars = Array.from(reason.trim());
    return chars.length > 80 ? `${chars.slice(0, 79).join("")}\u2026` : chars.join("");
  }
  function favoriteStrings(locale) {
    return locale === "zh-CN" ? zh3 : en3;
  }
  var CSS = `
:host { all: initial; }
.fav, .toast {
  position: fixed;
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.fav {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: #1f1f1f;
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18), inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.fav:hover { background: #333; }
.fav:focus-visible { outline: 2px solid #f5c518; outline-offset: 1px; }
.fav .star { color: #f5c518; font-size: 12px; }
.fav[data-state="saved"] .star, .fav[data-state="again"] .star { color: #4ade80; }
.fav[data-state="failed"] .star { color: #f87171; }
.fav[data-state="saving"] { cursor: progress; opacity: 0.85; }
/* A failure says why on the button; a long reason is cut, and its whole text is the tooltip. */
.fav .label { max-width: min(420px, calc(100vw - 64px)); overflow: hidden; text-overflow: ellipsis; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.toast {
  left: 50%;
  transform: translateX(-50%);
  max-width: min(520px, calc(100vw - 32px));
  padding: 8px 14px;
  border-radius: 10px;
  background: rgba(31, 31, 31, 0.94);
  color: #fff;
  font-size: 12.5px;
  line-height: 1.45;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
}
[hidden] { display: none !important; }
`;
  var HIGHLIGHT_CSS = `::highlight(${HIGHLIGHT_NAME}) { background-color: rgba(250, 204, 21, 0.8); color: #1f2328; }`;
  var boxOf = (rect) => ({
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  });
  var TOOLBAR_CANDIDATES = '[class*="popover" i], [class*="toolbar" i], [role="toolbar"], [role="menu"], [data-radix-popper-content-wrapper]';
  function hostToolbar(doc, rects, own) {
    const first = rects[0];
    const last = rects[rects.length - 1];
    if (!first || !last) return null;
    const left = Math.min(...rects.map((rect) => rect.left)) - 160;
    const right = Math.max(...rects.map((rect) => rect.right)) + 160;
    let candidates = [];
    try {
      candidates = [...doc.querySelectorAll(TOOLBAR_CANDIDATES), ...doc.querySelectorAll(":popover-open")];
    } catch {
      candidates = [...doc.querySelectorAll(TOOLBAR_CANDIDATES)];
    }
    let best = null;
    for (const element of candidates) {
      if (element === own || own.contains(element) || messageOf(element)) continue;
      if (!element.matches("button, [role=button]") && !element.querySelector("button, [role=button]")) continue;
      const box = boxOf(element.getBoundingClientRect());
      if (box.width <= 0 || box.height <= 0 || box.height > 64 || box.width > 520) continue;
      if (box.right < left || box.left > right) continue;
      const above = first.top - box.bottom;
      const below = box.top - last.bottom;
      const distance = above >= -4 && above <= 72 ? above : below >= -4 && below <= 72 ? below : Number.POSITIVE_INFINITY;
      if (distance === Number.POSITIVE_INFINITY) continue;
      if (!best || distance < best.distance) best = { box, distance };
    }
    return best?.box ?? null;
  }
  function overlayAt(doc, own, x, y) {
    let hits;
    try {
      hits = doc.elementsFromPoint(x, y);
    } catch {
      return null;
    }
    const top = hits.find((element) => element !== own && !own.contains(element) && element !== doc.documentElement && element !== doc.body);
    if (!top || messageOf(top) || top.querySelector(MESSAGE_SELECTOR)) return null;
    const view = doc.defaultView;
    let box = null;
    let positioned = false;
    for (let node = top; node && node !== doc.body; node = node.parentElement) {
      const rect = boxOf(node.getBoundingClientRect());
      if (rect.height > 64 || rect.width > 520 || node.querySelector(MESSAGE_SELECTOR)) break;
      box = rect;
      const position = view?.getComputedStyle(node).position;
      if (position === "fixed" || position === "absolute") positioned = true;
    }
    return positioned && box && box.width > 0 && box.height > 0 ? box : null;
  }
  function buttonSpot(rects, toolbar, size, viewport) {
    const first = rects[0];
    const last = rects[rects.length - 1];
    const height = toolbar ? Math.max(24, Math.min(36, toolbar.height)) : size.height;
    let left;
    let top;
    if (toolbar) {
      left = toolbar.right + GAP;
      if (left + size.width > viewport.width - MARGIN) left = toolbar.left - GAP - size.width;
      top = toolbar.top + (toolbar.height - height) / 2;
    } else {
      left = last.right - size.width / 2;
      top = first.top - height - GAP;
      if (top < MARGIN) top = last.bottom + GAP;
    }
    left = Math.max(MARGIN, Math.min(left, viewport.width - size.width - MARGIN));
    top = Math.max(MARGIN, Math.min(top, viewport.height - height - MARGIN));
    return { left: Math.round(left), top: Math.round(top), height: Math.round(height) };
  }
  function startFavorites(adapter, controller) {
    if (!adapter.doc.defaultView) return () => void 0;
    const favorites = new ConversationFavorites(adapter, controller);
    return () => favorites.stop();
  }
  var ConversationFavorites = class {
    #adapter;
    #controller;
    #doc;
    #win;
    #t;
    #host;
    #button;
    #label;
    /** Says how saving went, for screen readers. */
    #status;
    #toast;
    #cleanup = [];
    #timers = /* @__PURE__ */ new Set();
    #unmount = void 0;
    /** What the button would save: the selection when it settled. */
    #pending = null;
    #state = "idle";
    #dragging = false;
    #settleTimer;
    #feedbackTimer;
    #toastTimer;
    #highlightTimer;
    #highlightSheet = null;
    #revealed = /* @__PURE__ */ new Set();
    #revealing = null;
    #lastReport = "";
    #stopped = false;
    constructor(adapter, controller) {
      this.#adapter = adapter;
      this.#controller = controller;
      const doc = this.#doc = adapter.doc;
      this.#win = doc.defaultView;
      this.#t = favoriteStrings(hoverLocale(doc));
      const h = builder(doc);
      this.#host = doc.createElement("div");
      this.#host.setAttribute(HOST_ATTRIBUTE, adapter.surface);
      const style = this.#host.style;
      style.position = "fixed";
      style.left = "0";
      style.top = "0";
      style.width = "0";
      style.height = "0";
      style.zIndex = "2147483002";
      style.pointerEvents = "none";
      const shadow = this.#host.attachShadow({ mode: "open" });
      adoptStyles(shadow, CSS);
      this.#label = h("span", { class: "label", text: this.#t.save });
      this.#button = h(
        "button",
        { class: "fav", title: this.#t.title, attrs: { type: "button", hidden: "", "data-state": "idle" } },
        h("span", { class: "star", text: "\u2605", attrs: { "aria-hidden": "true" } }),
        this.#label
      );
      this.#status = h("div", { class: "sr-only", attrs: { role: "status", "aria-live": "polite" } });
      this.#toast = h("div", { class: "toast", attrs: { role: "status", hidden: "" } });
      shadow.append(this.#button, this.#status, this.#toast);
      this.#button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      this.#button.addEventListener("mousedown", (event) => event.preventDefault());
      this.#button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.#save();
      });
      this.#unmount = adapter.mount(this.#host);
      this.#listen(doc, "selectionchange", () => this.#selectionChanged());
      this.#listen(doc, "pointerdown", (event) => {
        if (this.#host.contains(event.target)) return;
        this.#dragging = true;
        this.#clearHighlightSoon();
      }, true);
      this.#listen(doc, "pointerup", () => {
        this.#dragging = false;
        this.#settleSoon();
      }, true);
      this.#listen(doc, "keyup", (event) => {
        if (event.shiftKey || event.key.startsWith("Arrow")) this.#settleSoon();
      }, true);
      this.#listen(doc, "keydown", (event) => {
        if (event.key === "Escape") this.#hideButton();
      }, true);
      this.#listen(this.#win, "scroll", () => this.#follow(), true);
      this.#listen(this.#win, "resize", () => this.#follow());
      this.#cleanup.push(controller.subscribe((_version, data) => this.#onData(data)));
      this.#later(() => this.#describeMessages(), 4e3);
    }
    #describeMessages() {
      if (!diagnosticsOn(this.#win)) return;
      const count = (selector) => this.#doc.querySelectorAll(selector).length;
      this.#report({
        messages: {
          flow: count("[data-chat-flow-kind]"),
          turnKey: count("[data-turn-key]"),
          searchKey: count("[data-content-search-turn-key]"),
          messageId: count("[data-message-id]"),
          role: count("[data-message-author-role]"),
          roots: messageRoots(this.#doc).length
        }
      });
    }
    stop() {
      if (this.#stopped) return;
      this.#stopped = true;
      for (const undo of this.#cleanup.splice(0)) undo();
      for (const timer of this.#timers) clearTimeout(timer);
      clearTimeout(this.#settleTimer);
      clearTimeout(this.#feedbackTimer);
      clearTimeout(this.#toastTimer);
      if (this.#revealing) clearTimeout(this.#revealing.timer);
      this.#clearHighlight();
      if (this.#highlightSheet) {
        const sheet = this.#highlightSheet;
        this.#doc.adoptedStyleSheets = this.#doc.adoptedStyleSheets.filter((item) => item !== sheet);
      }
      this.#unmount?.();
      this.#host.remove();
    }
    #listen(target, type, listener, capture = false) {
      target.addEventListener(type, listener, capture);
      this.#cleanup.push(() => target.removeEventListener(type, listener, capture));
    }
    #later(fn, ms) {
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        if (!this.#stopped) fn();
      }, ms);
      this.#timers.add(timer);
    }
    // -------------------------------------------------------------------------------------------
    // Saving a selection
    #selectionChanged() {
      if (this.#state === "saving") return;
      const selection = this.#win.getSelection();
      if (!selection || selection.isCollapsed) {
        if (this.#state === "idle") this.#hideButton();
        return;
      }
      if (!this.#dragging) this.#settleSoon();
    }
    #settleSoon() {
      clearTimeout(this.#settleTimer);
      this.#settleTimer = setTimeout(() => this.#settle(), SETTLE_MS);
    }
    /** The selection, when it is text in the open conversation's messages. */
    #selected() {
      const selection = this.#win.getSelection();
      const threadId = this.#controller.current();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !threadId) return null;
      if (!messageOf(selection.anchorNode) || !messageOf(selection.focusNode)) return null;
      const text = selection.toString().trim();
      if (Array.from(text).length < MIN_CHARS) return null;
      const range = selection.getRangeAt(0);
      const role = roleOf(range.startContainer);
      return { range, text, threadId, ...role ? { role } : {} };
    }
    #settle() {
      if (this.#stopped || this.#state === "saving") return;
      const found = this.#selected();
      if (!found) {
        if (this.#state === "idle") this.#hideButton();
        return;
      }
      if (this.#state !== "idle" && this.#pending?.text === found.text) return;
      this.#pending = { threadId: found.threadId, ...hostParams(this.#adapter, found.threadId), text: found.text, ...found.role ? { role: found.role } : {} };
      this.#setState("idle");
      this.#place(found.range);
      for (const ms of REPLACE_MS) this.#later(() => this.#follow(), ms);
    }
    /** Places the button again for the current selection (scrolling, the host's toolbar appearing). */
    #follow() {
      if (this.#button.hidden || this.#state === "saving") return;
      const selection = this.#win.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        if (this.#state === "idle") this.#hideButton();
        return;
      }
      this.#place(selection.getRangeAt(0));
    }
    #place(range) {
      const rects = [...range.getClientRects()].map(boxOf).filter((rect) => rect.width > 0 || rect.height > 0);
      const view = { width: this.#win.innerWidth, height: this.#win.innerHeight };
      if (!rects.length || rects.every((rect) => rect.bottom < 0 || rect.top > view.height)) {
        this.#hideButton();
        return;
      }
      this.#button.hidden = false;
      const measured = this.#button.getBoundingClientRect();
      const size = { width: measured.width || 64, height: 28 };
      let toolbar = hostToolbar(this.#doc, rects, this.#host);
      let spot = buttonSpot(rects, toolbar, size, view);
      if (!toolbar) {
        const first = rects[0];
        const last = rects[rects.length - 1];
        toolbar = overlayAt(this.#doc, this.#host, spot.left + size.width / 2, spot.top + spot.height / 2) ?? overlayAt(this.#doc, this.#host, (Math.min(first.left, last.left) + Math.max(first.right, last.right)) / 2, first.top - 18);
        if (toolbar) spot = buttonSpot(rects, toolbar, size, view);
      }
      const style = this.#button.style;
      style.left = `${spot.left}px`;
      style.top = `${spot.top}px`;
      style.height = `${spot.height}px`;
      this.#report({ shown: true, beside: Boolean(toolbar), toolbar: toolbar ? [toolbar.left, toolbar.top, toolbar.width, toolbar.height].map(Math.round) : null, at: [spot.left, spot.top] });
    }
    #hideButton() {
      clearTimeout(this.#feedbackTimer);
      this.#button.hidden = true;
      this.#pending = null;
      this.#setState("idle");
    }
    /** `reason`: why saving failed, shown on the button. */
    #setState(state, reason = "") {
      this.#state = state;
      this.#button.dataset.state = state;
      const label = { idle: this.#t.save, saving: this.#t.saving, saved: this.#t.saved, again: this.#t.again, failed: this.#t.failed(reason) }[state];
      this.#label.textContent = label;
      this.#status.textContent = state === "saved" || state === "again" || state === "failed" ? label : "";
    }
    async #save() {
      const pending = this.#pending;
      if (!pending || this.#state === "saving") return;
      this.#setState("saving");
      try {
        const result = await this.#adapter.invoke("favorites.add", pending);
        if (this.#stopped) return;
        this.#setState(result.added ? "saved" : "again");
        this.#feedbackTimer = setTimeout(() => this.#hideButton(), FEEDBACK_MS);
      } catch (error) {
        if (this.#stopped) return;
        const reason = failureReason(this.#t, error);
        this.#setState("failed", reason);
        this.#button.title = this.#t.failed(reason);
        this.#follow();
        this.#feedbackTimer = setTimeout(() => {
          this.#button.title = this.#t.title;
          this.#hideButton();
        }, FAILED_MS);
      }
    }
    // -------------------------------------------------------------------------------------------
    // Showing a saved passage again
    #onData(data) {
      const reveal = data.reveal;
      if (!reveal || this.#revealed.has(reveal.id) || reveal.threadId !== this.#controller.current()) return;
      this.#revealed.add(reveal.id);
      this.#reveal(reveal);
    }
    /** Looks for the passage until it is on screen, loading older turns after a while; then marks it. */
    #reveal(reveal) {
      if (this.#revealing) clearTimeout(this.#revealing.timer);
      const started = Date.now();
      let scrolls = 0;
      let tries = 0;
      let hidden = false;
      const revealing = { id: reveal.id, timer: void 0 };
      this.#revealing = revealing;
      const finish = (found) => {
        if (this.#revealing === revealing) this.#revealing = null;
        void this.#adapter.invoke("favorites.revealed", { id: reveal.id }).catch(() => void 0);
        this.#report({ reveal: found, tries, scrolls, hidden, ms: Date.now() - started });
        if (!found && !hidden) this.#showToast(this.#t.notFound);
      };
      const attempt = () => {
        if (this.#stopped || this.#revealing !== revealing) return;
        if (this.#controller.current() !== reveal.threadId) {
          finish(false);
          return;
        }
        tries += 1;
        const range = findPassage(this.#doc, reveal.text);
        hidden = Boolean(range) && range.getClientRects().length === 0;
        if (range && !hidden) {
          this.#highlight(range);
          finish(true);
          return;
        }
        const elapsed = Date.now() - started;
        if (elapsed >= REVEAL_FOR_MS) {
          finish(false);
          return;
        }
        if (!range && elapsed >= REVEAL_SCROLL_AFTER_MS && scrolls < REVEAL_SCROLLS) {
          const scroller = scrollerOf(messageRoots(this.#doc)[0]);
          if (scroller && scroller.scrollTop > 0) {
            scroller.scrollTop = 0;
            scrolls += 1;
          }
        }
        revealing.timer = setTimeout(attempt, REVEAL_EVERY_MS);
      };
      attempt();
    }
    #highlight(range) {
      this.#clearHighlight();
      const start = range.startContainer;
      const element = start.nodeType === 1 ? start : start.parentElement;
      element?.scrollIntoView({ block: "center", inline: "nearest" });
      const registry = this.#win.CSS?.highlights;
      const HighlightClass = this.#win.Highlight;
      if (registry && HighlightClass) {
        this.#ensureHighlightStyle();
        registry.set(HIGHLIGHT_NAME, new HighlightClass(range));
      } else {
        const selection = this.#win.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      this.#highlightTimer = setTimeout(() => this.#clearHighlight(), HIGHLIGHT_MS);
    }
    #ensureHighlightStyle() {
      if (this.#highlightSheet) return;
      const Sheet = this.#win.CSSStyleSheet;
      try {
        const sheet = new Sheet();
        sheet.replaceSync(HIGHLIGHT_CSS);
        this.#doc.adoptedStyleSheets = [...this.#doc.adoptedStyleSheets, sheet];
        this.#highlightSheet = sheet;
      } catch {
      }
    }
    /** Clicking anywhere a moment after the passage was shown takes the highlight off. */
    #clearHighlightSoon() {
      if (this.#highlightTimer === void 0) return;
      this.#later(() => this.#clearHighlight(), 250);
    }
    #clearHighlight() {
      clearTimeout(this.#highlightTimer);
      this.#highlightTimer = void 0;
      const registry = this.#win.CSS?.highlights;
      registry?.delete(HIGHLIGHT_NAME);
    }
    #showToast(text) {
      clearTimeout(this.#toastTimer);
      this.#toast.textContent = text;
      this.#toast.style.top = "64px";
      this.#toast.hidden = false;
      this.#toastTimer = setTimeout(() => {
        this.#toast.hidden = true;
      }, TOAST_MS2);
    }
    /**
     * Tells the backend log where the button went and how showing a passage went (rate limited there),
     * only while this surface's diagnostics are on (`diagnosticsOn`).
     */
    #report(report) {
      if (!diagnosticsOn(this.#win)) return;
      const text = JSON.stringify(report);
      if (text === this.#lastReport) return;
      this.#lastReport = text;
      void this.#adapter.invoke("diagnose", { surface: `${this.#adapter.surface}-favorites`, report }).catch(() => void 0);
    }
  };

  // src/ui/hover/card.ts
  var DONE_MILESTONES_SHOWN = 3;
  var DONE_TASKS_SHOWN = 3;
  var CHILDREN_SHOWN = 6;
  var REFS_SHOWN = 3;
  var COMPOSE_IDLE = { open: false, text: "", files: [], armed: null, busy: false };
  var shortId = (threadId) => `#${threadId.slice(0, 8)}`;
  function cardNodes(content, ctx) {
    const { h, t } = ctx;
    if (content.kind === "loading") return [h("div", { class: "note", text: t.loading })];
    if (content.kind === "error") return [h("div", { class: "note error", attrs: { role: "alert" }, text: t.failed(content.message) })];
    const view = content.view;
    return [
      news(view, ctx),
      head(view, ctx),
      relations(view, ctx),
      prompts(view, ctx),
      timeline(view, ctx),
      spinoffs(view, ctx),
      children(view, ctx),
      refs(view, ctx),
      compose(view, ctx)
    ].filter((node) => node !== null);
  }
  function news(view, ctx) {
    const { h, t, now } = ctx;
    const fresh = view.refs.filter((ref) => ref.activity?.unseen);
    if (!fresh.length) return null;
    return section(
      ctx,
      "news",
      t.news,
      null,
      ...fresh.map(
        (ref) => h(
          "div",
          { class: "news-row", attrs: { "data-ref": ref.key } },
          refRow(ref, ctx, () => ctx.actions.seen(ref.key)),
          h(
            "div",
            { class: "news-meta" },
            h("span", { text: `${t.reason(ref.activity.reason)} \xB7 ${t.time(ref.activity.at, now)}` }),
            h("button", { class: "btn small", text: t.seen, attrs: { type: "button" }, on: { click: () => ctx.actions.seen(ref.key) } })
          )
        )
      )
    );
  }
  function spinoffs(view, ctx) {
    const { h, t } = ctx;
    const open = view.spinoffs.filter((spinoff) => spinoff.state === "open");
    if (!open.length) return null;
    return section(
      ctx,
      "spinoffs",
      t.spinoffs,
      null,
      ...open.map(
        (spinoff) => h(
          "div",
          { class: "spinoff", attrs: { "data-spinoff": spinoff.id } },
          h("span", { class: "spinoff-text", text: spinoff.text }),
          spawnButton(ctx, spinoff.id, () => ({ spinoffId: spinoff.id, text: spinoff.text }))
        )
      )
    );
  }
  function spawnButton(ctx, key, target) {
    const { h, t } = ctx;
    const { armed, busy } = ctx.compose;
    const mine = armed === key;
    const uploading = ctx.compose.uploading;
    return h("button", {
      class: `btn spawn${mine ? " armed" : ""}`,
      text: mine && busy ? uploading !== void 0 ? t.uploading(uploading) : t.spawning : mine ? t.confirm : t.spawnChild,
      attrs: { type: "button", "data-spawn": key, disabled: busy ? "" : void 0 },
      on: {
        click: () => {
          const what = target();
          if (what) ctx.actions.spawn(what, key);
        }
      }
    });
  }
  function compose(view, ctx) {
    const { h, t } = ctx;
    const state = ctx.compose;
    const result = state.result ? state.result.ok ? h(
      "div",
      { class: "compose-result", attrs: { "data-ok": "" } },
      h("span", { text: t.spawned(state.result.title) }),
      (({ childThreadId, hostId }) => h("button", { class: "btn small", text: t.openIt, attrs: { type: "button" }, on: { click: () => ctx.actions.open(childThreadId, hostId) } }))(
        state.result
      )
    ) : state.result.pending ? h("div", { class: "compose-result", attrs: { "data-pending": "" }, text: state.result.message }) : h("div", { class: "compose-result", attrs: { role: "alert" }, text: t.spawnFailed(state.result.message) }) : null;
    if (!state.open)
      return h(
        "div",
        { class: "compose" },
        result,
        ctx.summaryRefused ? h("div", { class: "compose-result summary-refused", attrs: { role: "alert" }, text: t.noSummarizer }) : null,
        ctx.summaryFailed ? h("div", { class: "compose-result summary-refused", attrs: { role: "alert" }, text: ctx.summaryFailed }) : null,
        h(
          "div",
          { class: "compose-links" },
          h("button", { class: "more compose-open", text: t.newChild, attrs: { type: "button" }, on: { click: () => ctx.actions.compose(true) } }),
          h("button", {
            class: "more resummarize",
            text: ctx.summarizing ? t.summarizing : view.draft ? t.summarizeNow : t.resummarize,
            attrs: { type: "button", disabled: ctx.summarizing ? "" : void 0 },
            on: { click: () => ctx.actions.summarize() }
          })
        )
      );
    const input = h("input", {
      class: "compose-input",
      attrs: { type: "text", placeholder: t.newChildHint, "aria-label": t.newChildHint, maxlength: "200", disabled: state.busy ? "" : void 0 }
    });
    input.value = state.text;
    input.addEventListener("input", () => ctx.actions.type(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.isComposing || event.key !== "Enter") return;
      event.preventDefault();
      const text = input.value.trim();
      if (text) ctx.actions.spawn({ text }, "new");
    });
    const attach = ctx.remote ? null : h("button", {
      class: "attach",
      text: "\u{1F4CE}",
      title: t.attachTip,
      attrs: { type: "button", "aria-label": t.attach, disabled: state.busy ? "" : void 0 },
      on: { click: () => ctx.actions.attach() }
    });
    const notice = state.notice ?? (ctx.remote ? t.remoteFiles : void 0);
    return h(
      "div",
      { class: "compose", attrs: { "data-open": "", "data-remote": ctx.remote ? "" : void 0 } },
      result,
      h("div", { class: "compose-field" }, input, attach),
      state.files.length ? h("ul", { class: "attachments" }, ...state.files.map((file) => attachmentRow(file, ctx))) : null,
      notice ? h("div", { class: "compose-notice", attrs: { role: "status" }, text: notice }) : null,
      h(
        "div",
        { class: "compose-buttons" },
        spawnButton(ctx, "new", () => {
          const text = input.value.trim();
          return text ? { text } : null;
        }),
        h("button", { class: "btn", text: t.cancel, attrs: { type: "button", disabled: state.busy ? "" : void 0 }, on: { click: () => ctx.actions.compose(false) } })
      )
    );
  }
  var KIND_ICON = { image: "\u{1F5BC}", video: "\u{1F3AC}", file: "\u{1F4C4}" };
  function attachmentRow(file, ctx) {
    const { h, t } = ctx;
    return h(
      "li",
      { class: "attachment", title: file.name, attrs: { "data-kind": file.kind, "data-file": file.id } },
      h("span", { class: "attachment-icon", text: KIND_ICON[file.kind], attrs: { "aria-hidden": "true" } }),
      h("span", { class: "attachment-name", text: file.name }),
      h("span", { class: "attachment-size", text: formatSize(file.size) }),
      h("button", {
        class: "attachment-remove",
        text: "\xD7",
        title: t.detach(file.name),
        attrs: { type: "button", "aria-label": t.detach(file.name), disabled: ctx.compose.busy ? "" : void 0 },
        on: { click: () => ctx.actions.detach(file.id) }
      })
    );
  }
  function head(view, ctx) {
    const { h, t, now } = ctx;
    const status = view.threadStatus;
    return h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "title" },
        h("span", { class: "title-text", text: view.title }),
        view.draft ? h("span", { class: "chip draft", text: t.draft, title: t.draftTip }) : null
      ),
      h(
        "div",
        { class: "meta" },
        view.draft ? null : h("span", { class: "state", text: t.status[view.status], attrs: { "data-state": view.status } }),
        status !== "unknown" ? h("span", { class: "live", attrs: { "data-status": status } }, h("span", { class: "dot", attrs: { "data-status": status } }), t.live[status]) : null,
        view.updatedAt ? h("span", { class: "when", text: t.time(view.updatedAt, now), title: t.date(view.updatedAt) }) : null,
        view.summary ? h("span", { class: "when summarized", text: t.summarized(t.time(view.summary.at, now)), title: view.summary.model }) : null
      ),
      view.host ? h(
        "div",
        { class: "host", attrs: { "data-state": view.host.state }, title: t.hostTip },
        h("span", { class: "dot", attrs: { "data-host": view.host.state, "aria-hidden": "true" } }),
        h("span", { class: "host-text", text: t.host(view.host.name, view.host.state) })
      ) : null,
      view.tags.length ? h("div", { class: "tags" }, ...view.tags.map((tag) => h("span", { class: "chip", text: tag, title: tag }))) : null
    );
  }
  function relations(view, ctx) {
    const rows = [];
    if (view.parent) rows.push(relationRow(ctx.t.from, view.parent, "parent", ctx));
    if (view.related) rows.push(relationRow(ctx.t.related, view.related, "related", ctx));
    return rows.length ? ctx.h("div", { class: "relations" }, ...rows) : null;
  }
  function relationRow(label, other, role, ctx) {
    const { h, t } = ctx;
    return h(
      "button",
      {
        class: "rel",
        title: t.open(other.title),
        attrs: { type: "button", "data-role": role, "data-thread": other.threadId },
        on: { click: () => ctx.actions.open(other.threadId, other.hostId) }
      },
      h("span", { class: "rel-label", text: label }),
      h("span", { class: "dot", title: t.live[other.threadStatus], attrs: { "data-status": other.threadStatus } }),
      h("span", { class: "rel-title", text: other.title })
    );
  }
  function prompts(view, ctx) {
    const { h, t, now } = ctx;
    const lines = [];
    const first = view.firstPrompt?.trim();
    if (first) lines.push(h("div", { class: "prompt", attrs: { "data-role": "origin" } }, h("span", { class: "label", text: t.origin }), first));
    const last = view.lastPrompt;
    if (!view.now && last && last.text.trim() && last.text.trim() !== first)
      lines.push(
        h(
          "div",
          { class: "prompt", attrs: { "data-role": "last" } },
          h("span", { class: "label", text: t.lastPrompt }),
          last.text.trim(),
          h("span", { class: "when", text: t.time(last.at, now) })
        )
      );
    return lines.length ? h("div", { class: "prompts" }, ...lines) : null;
  }
  function section(ctx, role, title, count, ...children2) {
    const { h } = ctx;
    return h(
      "section",
      { class: "section", attrs: { "data-section": role } },
      h("div", { class: "section-title" }, h("span", { text: title }), count ? h("span", { class: "count", text: count }) : null),
      ...children2
    );
  }
  function moreButton(ctx, text, what) {
    return ctx.h("button", {
      class: "more",
      text,
      attrs: { type: "button", "data-expand": what },
      on: { click: () => ctx.actions.expand(what) }
    });
  }
  function timeline(view, ctx) {
    const { h, t } = ctx;
    const milestones = view.milestones;
    const count = view.progress.total > 0 ? `${view.progress.done}/${view.progress.total}` : null;
    if (!milestones.length) {
      if (view.draft) return null;
      if (view.now)
        return section(ctx, "milestones", t.milestones, count, h("ul", { class: "tasks" }, taskRow({ id: "now", text: view.now.text, done: false, at: view.now.at }, true, ctx)));
      return section(ctx, "milestones", t.milestones, count, h("div", { class: "note", text: t.noMilestones }));
    }
    let leading = 0;
    while (leading < milestones.length && milestones[leading]?.state === "done") leading += 1;
    const folded = !ctx.expanded.has("milestones") && leading > DONE_MILESTONES_SHOWN + 1 ? leading - DONE_MILESTONES_SHOWN : 0;
    const items = milestones.slice(folded).map((milestone) => milestoneRow(milestone, view, ctx));
    return section(
      ctx,
      "milestones",
      t.milestones,
      count,
      folded ? moreButton(ctx, t.earlierMilestones(folded), "milestones") : null,
      h("ol", { class: "timeline" }, ...items)
    );
  }
  function milestoneRow(milestone, view, ctx) {
    const { h, t, now } = ctx;
    const mark = milestone.state === "done" ? "\u2713" : milestone.state === "current" ? "\u25CF" : "\u25CB";
    return h(
      "li",
      { class: "ms", attrs: { "data-state": milestone.state, "data-id": milestone.id } },
      h("span", { class: "mark", text: mark, attrs: { "aria-hidden": "true" } }),
      h(
        "div",
        { class: "ms-body" },
        h(
          "div",
          { class: "ms-head" },
          h("span", { class: "ms-title", text: milestone.title }),
          milestone.state === "done" && milestone.doneAt ? h("span", { class: "when", text: t.time(milestone.doneAt, now), title: t.date(milestone.doneAt) }) : null
        ),
        milestone.state === "current" ? tasksOf(milestone, view, ctx) : null
      )
    );
  }
  function tasksOf(milestone, view, ctx) {
    const tasks = Array.isArray(milestone.tasks) ? milestone.tasks : [];
    const nowText = view.now?.text.trim();
    const nowIndex = nowText ? tasks.findIndex((task) => !task.done && task.text.trim() === nowText) : -1;
    const doneCount = tasks.filter((task) => task.done).length;
    const folded = !ctx.expanded.has("tasks") && doneCount > DONE_TASKS_SHOWN + 1 ? doneCount - DONE_TASKS_SHOWN : 0;
    const rows = [];
    let skipped = 0;
    tasks.forEach((task, index) => {
      if (task.done && skipped < folded) {
        skipped += 1;
        return;
      }
      rows.push(taskRow(task, index === nowIndex, ctx));
    });
    if (view.now && nowIndex < 0) rows.push(taskRow({ id: "now", text: view.now.text, done: false, at: view.now.at }, true, ctx));
    if (!rows.length) return null;
    const list = ctx.h("ul", { class: "tasks" }, ...rows);
    return folded ? ctx.h("div", null, moreButton(ctx, ctx.t.earlierTasks(folded), "tasks"), list) : list;
  }
  function taskRow(task, isNow, ctx) {
    const { h, t } = ctx;
    const kind = task.done ? "done" : isNow ? "now" : task.threadId ? "child" : "open";
    const mark = { done: "\u2713", now: "\u25B8", child: "\u21B3", open: "\u25E6" }[kind];
    const childId = task.threadId;
    const childTitle = childId ? task.threadTitle ?? shortId(childId) : void 0;
    return h(
      "li",
      { class: "task", attrs: { "data-kind": kind, "data-id": task.id } },
      h("span", { class: "mark", text: mark, attrs: { "aria-hidden": "true" } }),
      h(
        "div",
        { class: "task-body" },
        h("span", { class: "task-text", text: task.text }),
        isNow ? h("span", { class: "now-label", text: t.doing }) : null,
        childId && childTitle ? h("button", {
          class: "task-child",
          text: t.inChild(childTitle),
          title: t.open(childTitle),
          attrs: { type: "button", "data-thread": childId },
          on: { click: () => ctx.actions.open(childId) }
        }) : null
      )
    );
  }
  function children(view, ctx) {
    const { h, t } = ctx;
    if (!view.children.length) return null;
    const shown = ctx.expanded.has("children") ? view.children : view.children.slice(0, CHILDREN_SHOWN);
    const rest = view.children.length - shown.length;
    return section(
      ctx,
      "children",
      t.children(view.children.length),
      null,
      ...shown.map((child) => {
        const meta = [child.current, child.progress?.total ? `${child.progress.done}/${child.progress.total}` : null, child.draft ? t.draft : null].filter(Boolean).join(" \xB7 ");
        return h(
          "button",
          {
            class: "child",
            title: t.open(child.title),
            attrs: { type: "button", "data-thread": child.threadId },
            on: { click: () => ctx.actions.open(child.threadId, child.hostId) }
          },
          h("span", { class: "dot", title: t.live[child.threadStatus], attrs: { "data-status": child.threadStatus } }),
          h("span", { class: "child-body" }, h("span", { class: "child-title", text: child.title }), meta ? h("span", { class: "child-meta", text: meta }) : null)
        );
      }),
      rest > 0 ? moreButton(ctx, t.moreChildren(rest), "children") : null
    );
  }
  function refs(view, ctx) {
    const { t } = ctx;
    if (!view.refs.length) return null;
    const shown = ctx.expanded.has("refs") ? view.refs : view.refs.slice(0, REFS_SHOWN);
    const rest = view.refs.length - shown.length;
    return section(
      ctx,
      "refs",
      t.refs,
      null,
      ...shown.map((ref) => refRow(ref, ctx)),
      rest > 0 ? moreButton(ctx, t.moreRefs(rest), "refs") : null
    );
  }
  function refRow(ref, ctx, onFollow) {
    const { h, t } = ctx;
    const state = ref.state ?? "unknown";
    const href = /^https:\/\//iu.test(ref.url) ? ref.url : void 0;
    return h(
      "a",
      {
        class: "ref",
        title: ref.url,
        attrs: { href, target: href ? "_blank" : void 0, rel: "noopener noreferrer", "data-ref": ref.key },
        on: {
          click: () => {
            onFollow?.();
            ctx.actions.followed();
          }
        }
      },
      h("span", { class: "ref-number", text: `${t.kind[ref.kind] ?? ref.kind} #${ref.number}` }),
      h("span", { class: "ref-title", text: ref.title ?? ref.repo }),
      h("span", { class: "ref-state", text: t.refState[state] ?? state, attrs: { "data-state": state } })
    );
  }

  // src/ui/hover/layout.ts
  var CARD_WIDTH = 320;
  var GAP2 = 8;
  var EDGE3 = 8;
  var BADGE_GAP = 6;
  var BADGE_INSET = 10;
  var RIGHT_SHARE = 0.45;
  var LINE_MAX = 44;
  var CONTROL = "button, a[href], input, select, [role='button'], [role='menuitem'], [role='checkbox'], [role='switch']";
  function boxOf2(element) {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  }
  var POPUP_MAX_WIDTH = 480;
  var POPUP_EDGE = 32;
  var POPUP_REACH = 160;
  var STACK_MAX_HEIGHT = 120;
  function openPopovers(doc) {
    try {
      return [...doc.querySelectorAll(":popover-open")];
    } catch {
      return [];
    }
  }
  function drawnPart(popover) {
    const own = boxOf2(popover);
    if (own.width > 0 && own.height > 0) return popover;
    const view = popover.ownerDocument.defaultView;
    for (const inner of popover.querySelectorAll("*")) {
      const box = boxOf2(inner);
      if (box.width > 0 && box.height > 0 && view?.getComputedStyle(inner).position === "fixed") return inner;
    }
    return null;
  }
  function hostPopup(doc, row, sidebar, skip) {
    const edges = [row.right, ...sidebar && sidebar.width > 0 ? [sidebar.right] : []];
    const view = doc.defaultView;
    const popovers = openPopovers(doc);
    for (const candidate of [...popovers, ...doc.body?.children ?? []]) {
      if (skip(candidate)) continue;
      const element = popovers.includes(candidate) ? drawnPart(candidate) : candidate;
      if (!element) continue;
      const box = boxOf2(element);
      if (box.width <= 0 || box.height <= 0 || box.width > POPUP_MAX_WIDTH) continue;
      if (!edges.some((edge) => Math.abs(box.left - edge) <= POPUP_EDGE)) continue;
      if (box.bottom < row.top - POPUP_REACH || box.top > row.bottom + POPUP_REACH) continue;
      if (!popovers.includes(candidate) && view?.getComputedStyle(element).position !== "fixed") continue;
      return element;
    }
    return null;
  }
  function cardSpot(row, sidebar, size, viewport, beside = null) {
    const side = sidebar && sidebar.width > 0 && sidebar.height > 0 ? sidebar : row;
    if (beside && beside.height <= STACK_MAX_HEIGHT) {
      const lined = Math.round(Math.max(EDGE3, Math.min(beside.left, viewport.width - EDGE3 - size.width)));
      const below = beside.bottom + GAP2;
      if (below + size.height <= viewport.height - EDGE3) return { left: lined, top: Math.round(below) };
      const above = beside.top - GAP2 - size.height;
      if (above >= EDGE3) return { left: lined, top: Math.round(above) };
    }
    let left = Math.max(side.right, beside?.right ?? Number.NEGATIVE_INFINITY) + GAP2;
    if (left + size.width > viewport.width - EDGE3) {
      const before = side.left - GAP2 - size.width;
      left = before >= EDGE3 ? before : Math.max(EDGE3, viewport.width - EDGE3 - size.width);
    }
    const top = Math.max(EDGE3, Math.min(row.top, viewport.height - EDGE3 - size.height));
    return { left: Math.round(left), top: Math.round(top) };
  }
  function keepInside(top, height, viewport) {
    return Math.round(Math.max(EDGE3, Math.min(top, viewport.height - EDGE3 - height)));
  }
  function controlsLeft(row, box = boxOf2(row)) {
    const view = row.ownerDocument.defaultView;
    const threshold = box.left + box.width * RIGHT_SHARE;
    let left = Number.POSITIVE_INFINITY;
    for (const element of row.querySelectorAll("*")) {
      const isSvg = element.namespaceURI === "http://www.w3.org/2000/svg";
      if (isSvg && element.tagName.toLowerCase() !== "svg") continue;
      const control = element.matches(CONTROL);
      const leaf = element.childElementCount === 0;
      const text = leaf ? element.textContent?.trim() ?? "" : "";
      if (!control && !isSvg && !(leaf && (element.tagName === "IMG" || text && Array.from(text).length <= SHORT_TEXT))) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.left < threshold || rect.width > box.width / 2) continue;
      if (rect.bottom <= box.top || rect.top >= box.bottom) continue;
      if (view?.getComputedStyle(element).visibility === "hidden") continue;
      left = Math.min(left, rect.left);
    }
    return Number.isFinite(left) ? left : null;
  }
  var SHORT_TEXT = 8;
  var ICON_MIN = 8;
  var ICON_MAX = 36;
  var GUTTER_MAX = 40;
  var GUTTER_MIN = 10;
  var GUTTER_PAD = 4;
  function leadingIcon(row, box = boxOf2(row)) {
    const lineBottom = box.top + Math.min(box.height, LINE_MAX);
    const view = row.ownerDocument.defaultView;
    for (const element of row.querySelectorAll("svg, img, [role='img']")) {
      if (element.parentElement?.closest("svg")) continue;
      const rect = boxOf2(element);
      if (rect.width < ICON_MIN || rect.height < ICON_MIN || rect.width > ICON_MAX || rect.height > ICON_MAX) continue;
      if (rect.left > box.left + box.width * 0.3 || rect.bottom <= box.top || rect.top >= lineBottom) continue;
      if (view?.getComputedStyle(element).visibility === "hidden") continue;
      return rect;
    }
    return null;
  }
  function inSight(row, sidebar) {
    let shown = boxOf2(row);
    if (shown.width <= 0 || shown.height <= 0) return null;
    const view = row.ownerDocument.defaultView;
    const own = view?.getComputedStyle(row);
    if (own?.visibility === "hidden" || own?.display === "none") return null;
    if (typeof row.checkVisibility === "function" && !row.checkVisibility()) return null;
    const last = sidebar?.contains(row) ? sidebar : null;
    for (let node = row.parentElement; node && shown; node = node.parentElement) {
      const style = view?.getComputedStyle(node);
      if (style?.display === "none") return null;
      if (node === last || clips(style)) shown = intersection(shown, boxOf2(node));
      if (node === last) break;
    }
    if (shown && sidebar && !last) {
      const area = boxOf2(sidebar);
      if (area.width > 0 && area.height > 0) shown = intersection(shown, area);
    }
    return shown;
  }
  function newsBadgeSpot(row, sidebar) {
    const box = boxOf2(row);
    if (box.width <= 0 || box.height <= 0) return null;
    const middle = box.top + Math.min(box.height, LINE_MAX) / 2;
    const area = sidebar ? boxOf2(sidebar) : null;
    if (area && area.height > 0 && (middle < area.top || middle > area.bottom)) return null;
    const shown = inSight(row, sidebar);
    if (!shown || middle < shown.top || middle > shown.bottom) return null;
    const icon2 = leadingIcon(row, box);
    const iconLeft = icon2?.left ?? box.left + 12;
    const from = Math.max(area && area.width > 0 ? area.left : Number.NEGATIVE_INFINITY, iconLeft - GUTTER_MAX);
    const to = iconLeft - GUTTER_PAD;
    if (to - from >= GUTTER_MIN) return { x: Math.round((from + to) / 2), y: Math.round(middle) };
    if (icon2) return { x: Math.round(icon2.right - 3), y: Math.round(icon2.top + 2) };
    return { x: Math.round(box.left + 12), y: Math.round(middle) };
  }
  var ROW_CONTROLS = "button, a[href], [role='button'], [role='link'], [role='menuitem'], [role='checkbox'], [role='switch']";
  var FIELDS = "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox'], [role='searchbox']";
  function onRowControl(target, row) {
    const width = boxOf2(row).width;
    for (let node = target instanceof Element ? target : null; node && node !== row; node = node.parentElement) {
      if (node.matches(FIELDS)) return true;
      if (node.matches(ROW_CONTROLS) && boxOf2(node).width < width / 2) return true;
    }
    return false;
  }
  var BUTTONS = "button, a[href], [role='button'], [role='link']";
  var CONTROLS = `${BUTTONS}, ${FIELDS}, summary, label, [role='menuitem'], [role='tab'], [role='treeitem'], [role='option'], [role='checkbox'], [role='radio'], [role='switch']`;
  var PICTURES = "svg, img, canvas, video, [role='img']";
  var WIDE_SHARE = 0.6;
  var SUMMARY_PAD = 6;
  var SUMMARY_GAP = 3;
  var SUMMARY_BAND = 160;
  var SUMMARY_SIZE = { width: 44, height: 20 };
  var SUMMARY_STEP = 2;
  var overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  function intersection(a, b) {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    return right > left && bottom > top ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
  }
  function clips(style) {
    return Boolean(style) && [style.overflow, style.overflowX, style.overflowY].some((value) => Boolean(value) && value !== "visible");
  }
  function textBoxes(element, fallback) {
    const boxes = [];
    for (const node of element.childNodes) {
      if (node.nodeType !== 3 || !node.textContent?.trim()) continue;
      let box = null;
      try {
        const range = element.ownerDocument.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      } catch {
      }
      boxes.push(box ?? fallback);
    }
    return boxes;
  }
  function hostContent(doc, area, skip, isRow = () => false) {
    const view = doc.defaultView;
    const content = { hard: [], buttons: [], rows: [], scrolling: [] };
    const wide = area.width * WIDE_SHARE;
    const visit = (parent, clip, parentCursor, depth) => {
      if (depth > 80) return;
      for (const element of parent.children) {
        if (skip(element)) continue;
        const rect = boxOf2(element);
        if (rect.width <= 0 || rect.height <= 0) {
          const style2 = view?.getComputedStyle(element);
          if (style2?.display !== "none") visit(element, clips(style2) ? intersection(clip, rect) ?? clip : clip, style2?.cursor || parentCursor, depth + 1);
          continue;
        }
        const shown = intersection(rect, clip);
        if (!shown || !overlap(shown, area)) continue;
        const style = view?.getComputedStyle(element);
        const cursor = style?.cursor ?? "";
        const clipping = clips(style);
        const inner = clipping ? intersection(clip, rect) ?? clip : clip;
        if (style?.visibility === "hidden") {
          visit(element, inner, cursor, depth + 1);
          continue;
        }
        if (clipping && /auto|scroll|overlay/u.test(style?.overflowY ?? "") && element.scrollHeight - element.clientHeight > 1) content.scrolling.push(shown);
        if (element.matches(PICTURES)) {
          content.hard.push(shown);
          continue;
        }
        const clickable = element.matches(CONTROLS) || isRow(element) || cursor === "pointer" && parentCursor !== "pointer";
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
  function rightmostGap(boxes, top, bottom, from, to, width) {
    const taken = boxes.filter((box) => box.top < bottom && box.bottom > top).map((box) => [box.left - SUMMARY_GAP, box.right + SUMMARY_GAP]).sort((a, b) => b[1] - a[1]);
    let end = to;
    for (const [left, right] of taken) {
      if (right < end && end - Math.max(right, from) >= width) return end - width;
      end = Math.min(end, left);
      if (end - from < width) return null;
    }
    return end - from >= width ? end - width : null;
  }
  function summarySpot(sidebar, size, viewport, content, avoid = []) {
    const left = Math.max(sidebar.left, 0) + SUMMARY_PAD;
    const right = Math.min(sidebar.right, viewport.width) - SUMMARY_PAD;
    const top = Math.max(sidebar.top, 0);
    const bottom = Math.min(top + SUMMARY_BAND, sidebar.bottom, viewport.height - EDGE3);
    const inBand = (y) => y >= top && y + size.height <= bottom;
    const aboveIt = (y) => y >= EDGE3 && y + size.height <= top;
    const level = [...new Set([...content.hard, ...content.buttons, ...content.rows, ...avoid].map((box2) => Math.round(box2.top + box2.height / 2 - size.height / 2)))];
    const lines = [...level.filter(inBand).sort((a, b) => a - b)];
    for (let y = top + SUMMARY_PAD; inBand(y); y += SUMMARY_STEP) lines.push(y);
    lines.push(...level.filter(aboveIt).sort((a, b) => b - a));
    for (let y = top - SUMMARY_PAD - size.height; y >= EDGE3; y -= SUMMARY_STEP) lines.push(y);
    const find = (boxes) => {
      for (const y of lines) {
        const x = rightmostGap(boxes, y - SUMMARY_GAP, y + size.height + SUMMARY_GAP, left, right, size.width);
        if (x !== null) return { left: Math.round(x), top: Math.round(y) };
      }
      return null;
    };
    const hard = [...content.hard, ...avoid];
    const spot = find([...hard, ...content.buttons, ...content.rows, ...content.scrolling]) ?? find([...hard, ...content.buttons, ...content.rows]) ?? find([...hard, ...content.buttons]) ?? find(hard) ?? { left: Math.round(Math.max(left, right - size.width)), top: Math.round(top + SUMMARY_PAD) };
    const box = { ...spot, right: spot.left + size.width, bottom: spot.top + size.height, width: size.width, height: size.height };
    return { ...spot, over: content.scrolling.some((list) => overlap(list, box)) };
  }
  function badgeSpot(row, sidebar) {
    const full = boxOf2(row);
    if (full.width <= 0 || full.height <= 0) return null;
    const height = Math.min(full.height, LINE_MAX);
    const box = { ...full, height, bottom: full.top + height };
    const y = box.top + height / 2;
    if (sidebar) {
      const area = boxOf2(sidebar);
      if (area.height > 0 && (y < area.top || y > area.bottom)) return null;
    }
    const controls = controlsLeft(row, box);
    const x = controls === null ? box.right - BADGE_INSET : controls - BADGE_GAP;
    return { x: Math.round(x), y: Math.round(y) };
  }

  // src/ui/hover/styles.ts
  var HOVER_CSS = `
:host {
  all: initial;
}

.root {
  --cxm-bg-solid: #ffffff;
  --cxm-fg: #1f2328;
  --cxm-muted: #626a75;
  --cxm-faint: #646b75;
  --cxm-border: rgba(15, 23, 42, 0.12);
  --cxm-hover: rgba(15, 23, 42, 0.055);
  --cxm-accent: #2563eb;
  --cxm-accent-text: #1d4ed8;
  --cxm-accent-soft: rgba(37, 99, 235, 0.1);
  /* Text on an accent background. */
  --cxm-on-accent: #fff;
  --cxm-amber: #a35a06;
  --cxm-amber-dot: #f59e0b;
  --cxm-amber-soft: rgba(245, 158, 11, 0.13);
  --cxm-ok: #15803d;
  --cxm-danger: #c42b2b;
  --cxm-merged: #8250df;
  --cxm-shadow: 0 1px 2px rgba(15, 23, 42, 0.06), 0 10px 28px rgba(15, 23, 42, 0.12);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--cxm-fg);
  text-align: left;
  -webkit-font-smoothing: antialiased;
}

.root[data-scheme="dark"] {
  --cxm-bg-solid: #26272b;
  --cxm-fg: #e8e8ea;
  --cxm-muted: #a3a7ae;
  --cxm-faint: #9ba0a7;
  --cxm-border: rgba(255, 255, 255, 0.13);
  --cxm-hover: rgba(255, 255, 255, 0.07);
  --cxm-accent: #7aa7ff;
  --cxm-accent-text: #7aa7ff;
  --cxm-accent-soft: rgba(122, 167, 255, 0.12);
  --cxm-on-accent: #10141c;
  --cxm-amber: #f5bd5a;
  --cxm-amber-dot: #f5a524;
  --cxm-amber-soft: rgba(245, 165, 36, 0.14);
  --cxm-ok: #5bd18b;
  --cxm-danger: #ff7b72;
  --cxm-merged: #b392f0;
  --cxm-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 12px 32px rgba(0, 0, 0, 0.38);
}

[hidden] {
  display: none !important;
}

/* Read by screen readers, not shown. */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

button {
  font: inherit;
  color: inherit;
}

/* ---------------------------------------------------------------- card */

.card {
  position: fixed;
  box-sizing: border-box;
  width: 320px;
  max-width: calc(100vw - 16px);
  max-height: 70vh;
  padding: 10px 12px 11px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--cxm-border);
  border-radius: 10px;
  background: var(--cxm-bg-solid);
  box-shadow: var(--cxm-shadow);
  overflow-wrap: anywhere;
  cursor: default;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  app-region: no-drag;
  animation: cxm-hover-in 0.12s ease-out;
}

@keyframes cxm-hover-in {
  from {
    opacity: 0;
    transform: translateX(-4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .card {
    animation: none;
  }
}

.title {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.38;
}

.title-text {
  flex: 1;
  min-width: 0;
}

.chip {
  display: inline-block;
  max-width: 100%;
  box-sizing: border-box;
  padding: 0 6px;
  overflow: hidden;
  border-radius: 9px;
  background: var(--cxm-hover);
  color: var(--cxm-muted);
  font-size: 11px;
  font-weight: 400;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip.draft {
  flex: none;
  margin-top: 1px;
  background: var(--cxm-amber-soft);
  color: var(--cxm-amber);
  font-weight: 500;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 10px;
  margin-top: 3px;
  color: var(--cxm-muted);
  font-size: 11.5px;
}

.state[data-state="active"] {
  color: var(--cxm-accent);
}

.state[data-state="paused"] {
  color: var(--cxm-amber);
}

.state[data-state="done"] {
  color: var(--cxm-ok);
}

.live {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.when {
  flex: none;
  color: var(--cxm-faint);
  font-size: 11px;
  white-space: nowrap;
}

.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--cxm-faint);
}

.dot[data-status="running"] {
  background: var(--cxm-accent);
}

.dot[data-status="waiting"] {
  background: var(--cxm-amber-dot);
}

.dot[data-status="unknown"] {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--cxm-faint);
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}

/* The computer a conversation on another computer runs on, and whether it is connected. */
.host {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  margin-top: 4px;
  color: var(--cxm-muted);
  font-size: 11.5px;
}

.host-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dot[data-host="connected"] {
  background: var(--cxm-ok);
}

.dot[data-host="connecting"] {
  background: var(--cxm-amber-dot);
}

.dot[data-host="auth-error"],
.dot[data-host="offline"] {
  background: var(--cxm-danger);
}

.relations,
.prompts {
  display: grid;
  gap: 2px;
  margin-top: 8px;
}

button.rel {
  display: flex;
  align-items: center;
  gap: 6px;
  width: calc(100% + 12px);
  min-width: 0;
  margin: 0 -6px;
  padding: 2px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

button.rel:hover,
button.child:hover,
a.ref:hover {
  background: var(--cxm-hover);
}

.rel-label {
  flex: none;
  color: var(--cxm-muted);
}

.rel-title {
  min-width: 0;
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prompt {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  font-size: 12px;
}

.prompt .label {
  margin-right: 4px;
  color: var(--cxm-muted);
}

.prompt .when {
  margin-left: 6px;
}

.section {
  margin-top: 10px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
  color: var(--cxm-muted);
  font-size: 11.5px;
  font-weight: 600;
}

.section-title .count {
  margin-left: auto;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.note {
  color: var(--cxm-muted);
  font-size: 12px;
}

.note.error {
  color: var(--cxm-danger);
}

button.more {
  display: block;
  margin: 1px 0 2px 20px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--cxm-accent);
  font-size: 11.5px;
  cursor: pointer;
}

/* ---------------------------------------------------------------- milestones */

.timeline,
.tasks {
  margin: 0;
  padding: 0;
  list-style: none;
}

.ms {
  position: relative;
  display: flex;
  gap: 6px;
  padding-bottom: 3px;
}

.ms:not(:last-child)::before {
  content: "";
  position: absolute;
  top: 17px;
  bottom: 0;
  left: 6.5px;
  width: 1px;
  background: var(--cxm-border);
}

.mark {
  flex: none;
  width: 14px;
  color: var(--cxm-faint);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}

.ms[data-state="done"] > .mark {
  color: var(--cxm-ok);
}

.ms[data-state="current"] > .mark {
  color: var(--cxm-accent);
}

.ms-body {
  flex: 1;
  min-width: 0;
}

.ms-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  line-height: 18px;
}

.ms-title {
  flex: 1;
  min-width: 0;
}

.ms[data-state="current"] .ms-title {
  font-weight: 600;
}

.ms[data-state="planned"] .ms-title {
  color: var(--cxm-muted);
}

.tasks {
  margin: 1px 0 2px;
}

.task {
  display: flex;
  gap: 4px;
  padding: 1px 0;
  font-size: 12px;
  line-height: 17px;
}

.task > .mark {
  width: 12px;
  font-size: 10.5px;
  line-height: 17px;
}

.task[data-kind="done"] {
  color: var(--cxm-muted);
}

.task[data-kind="done"] > .mark {
  color: var(--cxm-ok);
}

.task[data-kind="now"] > .mark,
.task[data-kind="child"] > .mark {
  color: var(--cxm-accent);
}

.task[data-kind="now"] .task-text {
  font-weight: 500;
}

.task-body {
  flex: 1;
  min-width: 0;
}

.now-label {
  display: inline-block;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--cxm-accent-soft);
  color: var(--cxm-accent-text);
  font-size: 10.5px;
  line-height: 16px;
  white-space: nowrap;
}

button.task-child {
  display: block;
  max-width: 100%;
  padding: 0;
  overflow: hidden;
  border: 0;
  background: none;
  color: var(--cxm-accent);
  font-size: 11.5px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

button.task-child:hover {
  text-decoration: underline;
}

/* ---------------------------------------------------------------- children and links */

button.child {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: calc(100% + 12px);
  margin: 0 -6px;
  padding: 3px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

button.child .dot {
  margin-top: 6px;
}

.child-body {
  display: grid;
  flex: 1;
  min-width: 0;
}

.child-title {
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.child-meta {
  overflow: hidden;
  color: var(--cxm-muted);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

a.ref {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0 -6px;
  padding: 2px 6px;
  border-radius: 6px;
  color: inherit;
  font-size: 12px;
  text-decoration: none;
}

.ref-number {
  flex: none;
  color: var(--cxm-accent);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.ref-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ref-state {
  flex: none;
  color: var(--cxm-muted);
  font-size: 11px;
}

.ref-state[data-state="open"] {
  color: var(--cxm-ok);
}

.ref-state[data-state="merged"] {
  color: var(--cxm-merged);
}

.ref-state[data-state="closed"] {
  color: var(--cxm-danger);
}

.more-text {
  color: var(--cxm-faint);
  font-size: 11.5px;
}

/* ---------------------------------------------------------------- news, spin-offs, child conversations */

.section[data-section="news"] {
  padding: 6px 8px 7px;
  margin: 0 -4px 8px;
  border-radius: 8px;
  background: var(--cxm-amber-soft);
}

.section[data-section="news"] .section-title {
  color: var(--cxm-amber);
}

.news-row + .news-row {
  margin-top: 6px;
}

.news-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
  color: var(--cxm-muted);
  font-size: 11.5px;
}

.news-meta .btn {
  margin-left: auto;
}

.btn {
  box-sizing: border-box;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--cxm-border);
  border-radius: 6px;
  background: var(--cxm-bg-solid);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}

.btn:hover:not(:disabled) {
  background: var(--cxm-hover);
}

.btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.btn.small {
  height: 21px;
  padding: 0 7px;
  font-size: 11.5px;
}

.btn.spawn {
  border-color: transparent;
  background: var(--cxm-accent);
  color: var(--cxm-on-accent);
}

.btn.spawn:hover:not(:disabled) {
  background: var(--cxm-accent);
  filter: brightness(1.08);
}

.btn.spawn.armed {
  background: var(--cxm-amber-dot);
  color: #1f2328;
}

.spinoff {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}

.spinoff-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.spinoff-text::before {
  content: "\u2442 ";
  color: var(--cxm-faint);
}

.compose {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--cxm-border);
}

.compose-input {
  box-sizing: border-box;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--cxm-border);
  border-radius: 6px;
  background: var(--cxm-bg-solid);
  color: var(--cxm-fg);
  font: inherit;
  outline: none;
}

.compose-input:focus {
  border-color: var(--cxm-accent);
  box-shadow: 0 0 0 2px var(--cxm-accent-soft);
}

.compose-buttons {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.compose-field {
  display: flex;
  align-items: center;
  gap: 6px;
}

.compose-field .compose-input {
  flex: 1;
  min-width: 0;
}

.attach {
  flex: none;
  box-sizing: border-box;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--cxm-border);
  border-radius: 6px;
  background: var(--cxm-bg-solid);
  font-size: 14px;
  line-height: 26px;
  cursor: pointer;
}

.attach:hover:not(:disabled) {
  background: var(--cxm-hover);
}

.attach:disabled {
  opacity: 0.6;
  cursor: default;
}

.attachments {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}

.attachment {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 2px 3px 2px 6px;
  border-radius: 6px;
  background: var(--cxm-hover);
  font-size: 12px;
}

.attachment-icon {
  flex: none;
  font-size: 12px;
}

.attachment-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-size {
  flex: none;
  color: var(--cxm-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.attachment-remove {
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--cxm-muted);
  font-size: 14px;
  line-height: 18px;
  cursor: pointer;
}

.attachment-remove:hover:not(:disabled) {
  background: var(--cxm-border);
  color: var(--cxm-fg);
}

.attachment-remove:disabled {
  opacity: 0.5;
  cursor: default;
}

.compose-notice {
  margin-top: 5px;
  color: var(--cxm-amber);
  font-size: 11.5px;
}

/* Files dragged over the card: they can be dropped anywhere on it. */
.card[data-dragging] {
  outline: 2px dashed var(--cxm-accent);
  outline-offset: -4px;
}

.card[data-dragging]::after {
  content: attr(data-dragging);
  position: sticky;
  bottom: -11px;
  display: block;
  margin: 8px -12px -11px;
  padding: 7px 12px;
  background: var(--cxm-accent);
  color: var(--cxm-on-accent);
  font-weight: 500;
  text-align: center;
}

.compose-result {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--cxm-danger);
  font-size: 12px;
}

.compose-result[data-ok] {
  color: var(--cxm-ok);
}

.compose-result .btn {
  margin-left: auto;
}

.compose-links {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.more.resummarize {
  color: var(--cxm-muted);
}

.more:disabled {
  opacity: 0.6;
  cursor: default;
}

/* ---------------------------------------------------------------- row badge */

.badge {
  position: fixed;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  box-sizing: border-box;
  height: 18px;
  padding: 0 6px;
  border: 1px solid var(--cxm-border);
  border-radius: 9px;
  background: var(--cxm-bg-solid);
  color: var(--cxm-muted);
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
  transform: translate(-100%, -50%);
}

/* A bare bell beside the row's icon: GitHub news about a PR or issue this conversation started. */
.news-marker {
  position: fixed;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  pointer-events: none;
  transform: translate(-50%, -50%);
}

/* "\u{1F514} N" at the top of the sidebar: news whose conversation has no row in sight. */
.summary {
  position: fixed;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  box-sizing: border-box;
  height: 20px;
  margin: 0;
  padding: 0 7px 0 5px;
  border: 1px solid var(--cxm-border);
  border-radius: 10px;
  background: var(--cxm-bg-solid);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
  color: var(--cxm-fg);
  font-size: 11.5px;
  font-weight: 600;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.summary:hover,
.summary[aria-expanded="true"] {
  border-color: var(--cxm-amber-dot);
}

.summary:focus-visible,
.news-list .btn:focus-visible {
  outline: 2px solid var(--cxm-accent);
  outline-offset: 1px;
}

.summary-bell {
  font-size: 11px;
}

/* The list it opens. */
.news-list {
  position: fixed;
  box-sizing: border-box;
  width: 300px;
  max-width: calc(100vw - 16px);
  max-height: min(60vh, 420px);
  padding: 8px 10px 6px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--cxm-border);
  border-radius: 10px;
  background: var(--cxm-bg-solid);
  box-shadow: var(--cxm-shadow);
  overflow-wrap: anywhere;
  cursor: default;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.news-list .section-title {
  color: var(--cxm-amber);
}

.news-items {
  margin: 0;
  padding: 0;
  list-style: none;
}

.news-item {
  padding: 6px 0;
}

.news-item + .news-item {
  border-top: 1px solid var(--cxm-border);
}

.news-item-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
}

.news-item-head .ref-title {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  white-space: normal;
}

.news-item-meta {
  margin-top: 2px;
  color: var(--cxm-muted);
  font-size: 11.5px;
}

.news-item-actions {
  display: flex;
  gap: 6px;
  margin-top: 5px;
}

.badge .diamond {
  color: var(--cxm-accent);
  font-size: 9px;
}

.badge[data-complete] .diamond {
  color: var(--cxm-ok);
}
`;

  // src/ui/hover/upload.ts
  var UPLOAD_PARALLEL = 3;
  function base64(bytes) {
    let binary = "";
    for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
    return btoa(binary);
  }
  function bytesOf(blob) {
    if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
      reader.readAsArrayBuffer(blob);
    });
  }
  async function uploadFile(invoke, file, name, sent) {
    const begin = { name, size: file.size, ...file.type ? { type: file.type } : {} };
    const begun = await invoke("attach.begin", begin);
    const id = begun?.id;
    if (typeof id !== "string" || !id) throw new Error("the backend did not take the file");
    const offsets = [];
    for (let offset = 0; offset < file.size; offset += ATTACH_CHUNK_BYTES) offsets.push(offset);
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < offsets.length) {
        const offset = offsets[next++];
        try {
          const piece = file.slice(offset, offset + ATTACH_CHUNK_BYTES);
          const chunk = { id, offset, data: base64(new Uint8Array(await bytesOf(piece))) };
          await invoke("attach.chunk", chunk);
          if (!failed) sent(piece.size);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_PARALLEL, offsets.length) }, worker));
    return id;
  }

  // src/ui/hover/index.ts
  var SHOW_DELAY_MS = 400;
  var HIDE_DELAY_MS = 150;
  var PREFETCH_DELAY_MS = 100;
  var REBIND_MS = 1500;
  var HOST_ATTRIBUTE2 = "data-codexhost-mainline-hover";
  var CACHE_LIMIT = 100;
  var ERROR_LENGTH = 80;
  var CONFIRM_MS2 = 3e3;
  var PICKER_GRACE_MS = 1e3;
  var PRESS_MS = 5e3;
  var ACTIVATED_MS = 1500;
  var SEEN_WAIT_MS = 1e3;
  var LIST_ID = "cxm-news-list";
  var LIST_WIDTH = 300;
  var LIST_GAP = 6;
  var WINDOW_BUTTONS = { left: 0, top: 0, right: 84, bottom: 44, width: 84, height: 44 };
  var OVERLAYS = "[data-codexhost-mainline], [data-codexhost-mainline-hover], [data-codexhost-mainline-favorites]";
  var SUPPRESS_ATTRIBUTE = "data-codexhost-mainline-card";
  var PREVIEW_CSS = `:root[${SUPPRESS_ATTRIBUTE}] body > [style*="--dsh-hover-preview-fade"],
:root[${SUPPRESS_ATTRIBUTE}] [popover][id$="-hover-card"] {
  display: none !important;
}`;
  var quoted = (value) => value.replace(/["\\]/gu, "\\$&");
  var Stopped = class extends Error {
  };
  function pastedName(file, next) {
    const pasted = /^image\.(png|jpe?g|gif|webp|bmp|tiff?)$/iu.exec(file.name);
    if (file.name && !pasted) return file.name;
    const extension = pasted?.[1] ?? (file.type.startsWith("image/") ? file.type.slice(6).replace("jpeg", "jpg") : "bin");
    return `pasted-${next()}.${extension}`;
  }
  function startHover(adapter, controller) {
    if (!adapter.doc.defaultView || !adapter.sidebar || !adapter.rowAt) return () => void 0;
    const hover = new SidebarHover(adapter, controller);
    return () => hover.stop();
  }
  function isConversationView(value) {
    if (typeof value !== "object" || value === null) return false;
    const view = value;
    return typeof view.threadId === "string" && typeof view.title === "string" && Array.isArray(view.tags) && Array.isArray(view.milestones) && Array.isArray(view.children) && Array.isArray(view.refs) && typeof view.progress === "object" && view.progress !== null;
  }
  function shortError(error, t) {
    const code = errorCodeOf(error);
    const message = error instanceof Error ? error.message : String(error);
    if (code === "NO_THREAD") return t.noThread;
    if (isErrorCode(code)) return strings(t.locale).error(code, message);
    const line = errorDetail(message).split("\n")[0]?.trim() ?? "";
    const chars = Array.from(line);
    return chars.length > ERROR_LENGTH ? `${chars.slice(0, ERROR_LENGTH - 1).join("")}\u2026` : line || "?";
  }
  var SidebarHover = class {
    #adapter;
    #doc;
    #win;
    #h;
    #host;
    #root;
    #card;
    #badge;
    /** The file picker behind the card's 📎 button; outside the card, which is rebuilt all the time. */
    #picker;
    /**
     * Tells screen readers that a button waits for its confirming click, or that a child is still
     * opening; outside the card, so rebuilding the card does not take it away mid-sentence.
     */
    #live;
    #cleanup = [];
    #actions;
    #sidebar = null;
    #unbindSidebar;
    /** The row under the pointer. */
    #row = null;
    /** The row whose card is showing; null while the card is hidden. */
    #shown = null;
    #overCard = false;
    #showTimer;
    #hideTimer;
    #prefetchTimer;
    #framePending = false;
    #version;
    /** Bumped with every new snapshot version; answers to older requests are dropped. */
    #generation = 0;
    #cache = /* @__PURE__ */ new Map();
    /** Views of the previous version, shown until fresh ones arrive. */
    #stale = /* @__PURE__ */ new Map();
    #errors = /* @__PURE__ */ new Map();
    #pending = /* @__PURE__ */ new Map();
    #expanded = /* @__PURE__ */ new Set();
    /** What the card shows now, to skip rebuilding it when nothing changed. */
    #rendered = null;
    /** The host's own preview of the row that the card sits beside, if any (only where hiding it did not work). */
    #beside = null;
    #overBeside = false;
    /** A conversation id over its row, null over the card or outside the sidebar, undefined over an unhandled sidebar row. */
    #pointerThread = null;
    /** Whether the host's previews are hidden now (SUPPRESS_ATTRIBUTE on the document root). */
    #suppressing = false;
    /** Takes PREVIEW_CSS off the page again. */
    #removeStyles;
    #controller;
    /** Opening a child conversation from the card. */
    #compose = COMPOSE_IDLE;
    /** The files listed in #compose, by their id there. */
    #files = /* @__PURE__ */ new Map();
    #fileSeq = 0;
    /** The file picker is open: the window has lost the focus to it, and the card stays. */
    #picking = false;
    #pickTimer;
    /** Bumped when the card closes, which stops an upload under way. */
    #uploadRun = 0;
    #dragTimer;
    #armTimer;
    /**
     * A child conversation codexhost had not answered for in time: what was asked, in which card. What
     * was typed and attached stays until the conversation's view shows the child linked.
     */
    #awaiting = null;
    /** A render put off while the user typed; done once the field loses focus. */
    #renderLater = false;
    /** Summaries asked for from the card, by conversation, and when. */
    #summarizing = /* @__PURE__ */ new Map();
    /** The conversation whose summary was just refused: no model is set for its agent. Shown until the card closes. */
    #summaryRefused = null;
    /** A summary asked for that failed for another reason, and why. Shown until the card closes or the next try. */
    #summaryFailed = null;
    /** Conversations with unseen GitHub news about PRs and issues they started, and how many. */
    #news = /* @__PURE__ */ new Map();
    /** That news, from the latest snapshot. */
    #alerts = [];
    /** The bell on each such conversation's row in the sidebar. */
    #markers = /* @__PURE__ */ new Map();
    /** The row pressed last, until its click. */
    #press = null;
    /** The conversation whose news was last marked seen from its row, and when. */
    #activated = null;
    /** "🔔 N" at the top of the sidebar: news whose conversation has no row in sight here. */
    #summary;
    /** The list the summary opens. */
    #list;
    /** The news the summary counts, newest first. */
    #unplaced = [];
    /** What the summary's place was worked out for (sidebar, window and text), and whether it sits over a list that scrolls. */
    #summaryFor = "";
    #summaryOverList = false;
    /** What the list shows now, to skip rebuilding it when nothing changed. */
    #listShows = "";
    #stopped = false;
    constructor(adapter, controller) {
      this.#adapter = adapter;
      this.#controller = controller;
      const doc = this.#doc = adapter.doc;
      this.#win = doc.defaultView;
      const h = this.#h = builder(doc);
      this.#host = doc.createElement("div");
      this.#host.setAttribute(HOST_ATTRIBUTE2, adapter.surface);
      const style = this.#host.style;
      style.position = "fixed";
      style.left = "0";
      style.top = "0";
      style.width = "0";
      style.height = "0";
      style.zIndex = "2147483001";
      style.pointerEvents = "none";
      style.setProperty("-webkit-app-region", "no-drag");
      style.setProperty("app-region", "no-drag");
      const shadow = this.#host.attachShadow({ mode: "open" });
      adoptStyles(shadow, HOVER_CSS);
      this.#card = h("div", { class: "card", attrs: { role: "dialog", hidden: "" } });
      this.#badge = h("div", { class: "badge", attrs: { "aria-hidden": "true", hidden: "" } });
      this.#picker = h("input", { class: "picker", attrs: { type: "file", multiple: "", hidden: "", tabindex: "-1", "aria-hidden": "true" } });
      this.#live = h("div", { class: "sr-only", attrs: { role: "status", "aria-live": "polite" } });
      this.#summary = h("button", {
        class: "summary",
        attrs: { type: "button", hidden: "", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": LIST_ID },
        on: { click: () => this.#toggleList() }
      });
      this.#list = h("div", { class: "news-list", attrs: { id: LIST_ID, role: "dialog", hidden: "" } });
      this.#root = h("div", { class: "root" }, this.#card, this.#badge, this.#summary, this.#list, this.#picker, this.#live);
      shadow.append(this.#root);
      this.#actions = {
        open: (threadId, hostId) => {
          try {
            if (hostId) this.#adapter.openThread(threadId, hostId);
            else this.#adapter.openThread(threadId);
          } catch (error) {
            console.warn("[mainline] could not open the conversation", error);
          } finally {
            this.#hide();
          }
        },
        expand: (what) => {
          this.#expanded.add(what);
          this.#renderCard();
        },
        // Let the link open first; the card has done its job.
        followed: () => {
          this.#cancelHide();
          this.#hideTimer = setTimeout(() => this.#hide(), 0);
        },
        compose: (open) => {
          clearTimeout(this.#armTimer);
          this.#files.clear();
          this.#setCompose({ ...COMPOSE_IDLE, open });
          if (open) this.#focusField();
        },
        // Typing changes nothing on screen; the text is kept for the next render.
        type: (text) => {
          this.#compose = { ...this.#compose, text };
        },
        attach: () => {
          if (this.#compose.busy) return;
          if (this.#shown && this.#remote(this.#shown.threadId)) {
            this.#setCompose({ ...this.#compose, open: true, notice: this.#strings().remoteFiles });
            return;
          }
          this.#picking = true;
          clearTimeout(this.#pickTimer);
          try {
            this.#picker.click();
          } catch {
            this.#picking = false;
          }
        },
        detach: (fileId) => {
          if (this.#compose.busy) return;
          this.#files.delete(fileId);
          const { notice: _notice, ...rest } = this.#compose;
          this.#setCompose({ ...rest, files: rest.files.filter((file) => file.id !== fileId) });
        },
        spawn: (target, key) => this.#spawn(target, key),
        summarize: () => {
          const threadId = this.#shown?.threadId;
          if (!threadId) return;
          this.#summaryRefused = null;
          this.#summaryFailed = null;
          this.#summarizing.set(threadId, Date.now());
          this.#renderCard(false, true);
          void Promise.resolve().then(() => this.#adapter.invoke("summarize", { threadId, ...this.#onHost(threadId) })).catch((error) => {
            this.#summarizing.delete(threadId);
            const code = errorCodeOf(error);
            if (this.#shown?.threadId === threadId) {
              if (code === "NO_SUMMARIZER") this.#summaryRefused = threadId;
              else if (isErrorCode(code)) this.#summaryFailed = { threadId, message: shortError(error, this.#strings()) };
            }
            this.#renderCard(false, true);
          });
        },
        seen: (refKey) => {
          void Promise.resolve().then(() => this.#adapter.invoke("refs.seen", { key: refKey })).then(() => this.#controller.refresh()).catch(() => void 0);
        }
      };
      this.#listen(this.#card, "pointerenter", () => {
        this.#overCard = true;
        this.#cancelHide();
        this.#suppress();
      });
      this.#listen(this.#card, "pointerleave", () => {
        this.#overCard = false;
        this.#suppress();
        if (!this.#row) this.#scheduleHide();
      });
      this.#listen(this.#card, "focusout", () => {
        setTimeout(() => {
          if (this.#stopped || this.#typing()) return;
          if (this.#renderLater) {
            this.#renderLater = false;
            this.#renderCard();
          }
          if (this.#shown && !this.#row && !this.#overCard && !this.#overBeside) this.#scheduleHide();
        }, 0);
      });
      this.#listen(doc, "keydown", (event) => {
        if (event.key !== "Escape") return;
        if (this.#shown || this.#showTimer) this.#hide();
        if (!this.#list.hidden) this.#closeList(this.#focusIn(this.#list) || this.#focusIn(this.#summary));
      }, true);
      this.#listen(doc, "pointerdown", (event) => {
        if (this.#list.hidden) return;
        const path = event.composedPath();
        if (!path.includes(this.#list) && !path.includes(this.#summary)) this.#closeList(false);
      }, true);
      this.#listen(doc, "visibilitychange", () => {
        if (doc.visibilityState === "hidden" && !this.#holding()) this.#reset();
      });
      this.#listen(this.#win, "blur", () => {
        if (!this.#holding()) this.#reset();
      });
      this.#listen(this.#picker, "change", () => {
        this.#picking = false;
        const files = [...this.#picker.files ?? []];
        this.#picker.value = "";
        this.#addFiles(files);
      });
      this.#listen(this.#picker, "cancel", () => {
        this.#picking = false;
      });
      this.#listen(this.#win, "focus", () => {
        if (!this.#picking) return;
        clearTimeout(this.#pickTimer);
        this.#pickTimer = setTimeout(() => this.#picking = false, PICKER_GRACE_MS);
      });
      this.#listen(this.#card, "paste", (event) => {
        const files = [...event.clipboardData?.files ?? []];
        if (!files.length || !this.#compose.open) return;
        event.preventDefault();
        this.#addFiles(files);
      });
      const dragging = (event) => {
        const transfer = event.dataTransfer;
        if (!transfer || !Array.from(transfer.types ?? []).includes("Files") || this.#compose.busy) return;
        if (this.#shown && this.#remote(this.#shown.threadId)) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        transfer.dropEffect = "copy";
        this.#cancelHide();
        this.#card.setAttribute("data-dragging", this.#strings().dropHere);
        clearTimeout(this.#dragTimer);
        this.#dragTimer = setTimeout(() => this.#card.removeAttribute("data-dragging"), 250);
      };
      this.#listen(this.#card, "dragenter", dragging);
      this.#listen(this.#card, "dragover", dragging);
      this.#listen(this.#card, "drop", (event) => {
        clearTimeout(this.#dragTimer);
        this.#card.removeAttribute("data-dragging");
        const files = [...event.dataTransfer?.files ?? []];
        if (!files.length) return;
        event.preventDefault();
        this.#addFiles(files);
      });
      this.#listen(doc, "scroll", (event) => this.#onScroll(event), { capture: true, passive: true });
      this.#listen(this.#win, "resize", () => this.#onScroll(null));
      this.#removeStyles = documentStyles(doc, PREVIEW_CSS);
      const popups = new this.#win.MutationObserver(() => this.#makeRoom());
      popups.observe(doc.body ?? doc.documentElement, { childList: true });
      this.#cleanup.push(() => popups.disconnect());
      this.#listen(doc, "toggle", () => this.#makeRoom(), true);
      this.#cleanup.push(
        controller.subscribe((version, data) => {
          this.#onVersion(version);
          this.#onNews(data);
        })
      );
      this.#bindSidebar();
      const rebind = setInterval(() => {
        this.#bindSidebar();
        this.#placeMarkers(true);
      }, REBIND_MS);
      this.#cleanup.push(() => clearInterval(rebind));
    }
    stop() {
      if (this.#stopped) return;
      this.#stopped = true;
      this.#uploadRun += 1;
      clearTimeout(this.#pickTimer);
      clearTimeout(this.#dragTimer);
      this.#files.clear();
      clearTimeout(this.#showTimer);
      this.#cancelHide();
      clearTimeout(this.#prefetchTimer);
      this.#unbindSidebar?.();
      this.#unbindSidebar = void 0;
      this.#bridge(null);
      this.#shown = null;
      this.#row = null;
      this.#pointerThread = null;
      this.#suppress();
      this.#removeStyles?.();
      this.#removeStyles = void 0;
      for (const stop of this.#cleanup.splice(0)) {
        try {
          stop();
        } catch {
        }
      }
      this.#host.remove();
      this.#markers.clear();
      this.#alerts = [];
      this.#unplaced = [];
      this.#press = null;
      this.#cache.clear();
      this.#stale.clear();
      this.#errors.clear();
      this.#pending.clear();
      this.#row = null;
      this.#shown = null;
    }
    // -------------------------------------------------------------------------------------------
    // Following the pointer
    #listen(target, type, listener, options) {
      target.addEventListener(type, listener, options);
      this.#cleanup.push(() => target.removeEventListener(type, listener, options));
    }
    /** Listens on the sidebar the adapter reports, moving over when the host draws a new one. */
    #bindSidebar() {
      if (this.#stopped) return;
      let next;
      try {
        next = this.#adapter.sidebar?.() ?? null;
      } catch {
        next = null;
      }
      if (next === this.#sidebar) return;
      this.#unbindSidebar?.();
      this.#unbindSidebar = void 0;
      this.#sidebar = next;
      if (this.#row && !next?.contains(this.#row.element)) this.#leaveRow();
      if (!next) return;
      const over = (event) => this.#onOver(event);
      const out = (event) => this.#onOut(event);
      const leave = () => this.#leaveRow();
      const down = (event) => {
        this.#notePress(event);
        this.#hide();
      };
      const click = (event) => this.#onRowClick(event);
      const key = (event) => this.#onRowKey(event);
      next.addEventListener("pointerover", over);
      next.addEventListener("pointerout", out);
      next.addEventListener("pointerleave", leave);
      next.addEventListener("pointerdown", down, true);
      next.addEventListener("click", click, true);
      next.addEventListener("keydown", key, true);
      this.#unbindSidebar = () => {
        next.removeEventListener("pointerover", over);
        next.removeEventListener("pointerout", out);
        next.removeEventListener("pointerleave", leave);
        next.removeEventListener("pointerdown", down, true);
        next.removeEventListener("click", click, true);
        next.removeEventListener("keydown", key, true);
      };
    }
    /** The conversation row under an event target, if any. */
    #rowAt(target) {
      try {
        return this.#adapter.rowAt?.(target) ?? null;
      } catch {
        return null;
      }
    }
    /** Whether this conversation's bell is on screen in the sidebar now. */
    #bellInSight(threadId) {
      const marker = this.#markers.get(threadId);
      return Boolean(marker?.isConnected && !marker.hidden);
    }
    /**
     * Whether the user can see that this conversation has news: its bell in the sidebar, or the news
     * on top of its hover card. The bell hides while its row is hovered, so the row under the pointer
     * counts when the bell was in sight as the pointer came onto it.
     */
    #newsShowing(threadId) {
      if (this.#bellInSight(threadId)) return true;
      if (this.#row?.threadId === threadId && this.#row.bell) return true;
      return this.#shown?.threadId === threadId && !this.#card.hidden && this.#card.querySelector('[data-section="news"]') !== null;
    }
    #notePress(event) {
      const hit = this.#rowAt(event.target);
      this.#press = hit && !onRowControl(event.target, hit.element) ? { threadId: hit.threadId, box: boxOf2(hit.element), at: Date.now(), showing: this.#newsShowing(hit.threadId) } : null;
    }
    /**
     * A click that opens a conversation from its row while its bell or its card's news showed (as it
     * was when the row was pressed) marks the news of the PRs and issues it started as seen. Clicks on
     * the row's own small buttons (pin, archive, a menu) do not open it, and do not count.
     */
    #onRowClick(event) {
      const press = this.#press;
      this.#press = null;
      const recent = press && Date.now() - press.at < PRESS_MS ? press : null;
      let hit = this.#rowAt(event.target);
      if (!hit && recent && event.clientX >= recent.box.left && event.clientX <= recent.box.right && event.clientY >= recent.box.top && event.clientY <= recent.box.bottom)
        hit = { element: null, threadId: recent.threadId };
      if (!hit || hit.element && onRowControl(event.target, hit.element)) return;
      const showing = recent?.threadId === hit.threadId ? recent.showing : this.#newsShowing(hit.threadId);
      if (showing) this.#seenFromRow(hit.threadId);
    }
    /** Enter on a row opens it too (a row that is a button or link also gets a click, which counts once with it). */
    #onRowKey(event) {
      if (event.key !== "Enter" || event.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const hit = this.#rowAt(event.target);
      if (!hit || onRowControl(event.target, hit.element)) return;
      if (this.#newsShowing(hit.threadId)) this.#seenFromRow(hit.threadId);
    }
    /** Marks seen the news of every PR and issue this conversation started, as opening it from its row while the news showed. */
    #seenFromRow(threadId) {
      const last = this.#activated;
      if (last?.threadId === threadId && Date.now() - last.at < ACTIVATED_MS) return;
      this.#activated = { threadId, at: Date.now() };
      void Promise.resolve().then(() => this.#adapter.invoke("refs.seenForThread", { threadId, ...this.#onHost(threadId) })).then(() => this.#controller.refresh()).catch(() => void 0);
    }
    /**
     * The `hostId` a call names this conversation's remote host by, when it is on another computer:
     * its row's, else what the surface knows; nothing for a local conversation.
     */
    #onHost(threadId) {
      const row = this.#shown?.threadId === threadId ? this.#shown : this.#row?.threadId === threadId ? this.#row : null;
      return row?.hostId ? { hostId: row.hostId } : hostParams(this.#adapter, threadId);
    }
    /** Whether a conversation runs on another computer. */
    #remote(threadId) {
      return this.#onHost(threadId).hostId !== void 0;
    }
    #onOver(event) {
      if (event.pointerType === "touch") return;
      const hit = this.#rowAt(event.target);
      if (hit) this.#enterRow(hit);
      else this.#leaveRow(true);
    }
    #onOut(event) {
      if (event.pointerType === "touch") return;
      const to = event.relatedTarget;
      if (to instanceof Node && this.#sidebar?.contains(to)) return;
      this.#leaveRow();
    }
    #enterRow(found) {
      this.#cancelHide();
      this.#pointerThread = found.threadId;
      if (this.#shown && this.#holding() && found.threadId !== this.#shown.threadId) {
        this.#suppress();
        return;
      }
      const row = this.#row;
      if (row && row.element === found.element && row.threadId === found.threadId) {
        this.#suppress();
        return;
      }
      const bell = this.#bellInSight(found.threadId) || row?.threadId === found.threadId && row.bell;
      const hit = { element: found.element, threadId: found.threadId, box: boxOf2(found.element), bell, ...found.hostId ? { hostId: found.hostId } : {} };
      this.#row = hit;
      clearTimeout(this.#prefetchTimer);
      this.#renderBadge();
      this.#placeMarkers();
      if (!this.#cache.has(hit.threadId)) this.#prefetchTimer = setTimeout(() => this.#load(hit.threadId), PREFETCH_DELAY_MS);
      if (this.#shown) {
        this.#show(hit);
        return;
      }
      clearTimeout(this.#showTimer);
      this.#showTimer = setTimeout(() => {
        this.#showTimer = void 0;
        if (this.#row === hit) this.#show(hit);
      }, SHOW_DELAY_MS);
      this.#suppress();
    }
    #leaveRow(overOtherSidebarItem = false) {
      clearTimeout(this.#showTimer);
      this.#showTimer = void 0;
      clearTimeout(this.#prefetchTimer);
      this.#row = null;
      this.#pointerThread = overOtherSidebarItem ? void 0 : null;
      this.#badge.hidden = true;
      this.#placeMarkers();
      if (this.#shown && !this.#overCard) this.#scheduleHide();
      this.#suppress();
    }
    /** Hides the card soon, unless the pointer comes back to a row or onto the card (or the host's preview beside it) first. */
    #scheduleHide() {
      if (this.#hideTimer !== void 0) return;
      this.#hideTimer = setTimeout(() => {
        this.#hideTimer = void 0;
        if (!this.#row && !this.#overCard && !this.#overBeside && !this.#holding()) this.#hide();
      }, HIDE_DELAY_MS);
    }
    /**
     * The user is in the middle of a new problem: typing it, picking files for it or having added
     * some, or opening the child conversation. The card stays with its conversation meanwhile.
     */
    #holding() {
      return this.#compose.busy || this.#picking || this.#compose.files.length > 0 || this.#typing();
    }
    #focusField() {
      const field = this.#card.querySelector("input.compose-input");
      if (field && !field.disabled) {
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      }
    }
    /** Adds picked, pasted or dropped files to the new problem, opening its field if need be. */
    #addFiles(list) {
      if (!this.#shown || this.#compose.busy || !list.length) return;
      const t = this.#strings();
      if (this.#remote(this.#shown.threadId)) {
        const { result: _result2, ...rest2 } = this.#compose;
        const opening2 = !rest2.open;
        this.#setCompose({ ...rest2, open: true, notice: t.remoteFiles });
        if (opening2) this.#focusField();
        return;
      }
      const files = [...this.#compose.files];
      let total = files.reduce((sum, file) => sum + file.size, 0);
      let pasted = files.filter((file) => /^pasted-\d+\./u.test(file.name)).length;
      let notice;
      for (const file of list) {
        if (files.length >= ATTACH_MAX_FILES) {
          notice = t.tooMany(ATTACH_MAX_FILES);
          break;
        }
        const name = pastedName(file, () => ++pasted);
        if (file.size > ATTACH_MAX_FILE_BYTES) notice = t.tooLarge(name, formatSize(ATTACH_MAX_FILE_BYTES));
        else if (total + file.size > ATTACH_MAX_TOTAL_BYTES) notice = t.tooMuch(formatSize(ATTACH_MAX_TOTAL_BYTES));
        else {
          const id = `f${++this.#fileSeq}`;
          this.#files.set(id, file);
          files.push({ id, name, size: file.size, kind: attachmentKind(name, file.type) });
          total += file.size;
        }
      }
      const { result: _result, notice: _notice, ...rest } = this.#compose;
      const opening = !rest.open;
      this.#setCompose({ ...rest, open: true, files, armed: null, ...notice ? { notice } : {} });
      if (opening) this.#focusField();
    }
    /** Sends the files of the new problem to the backend, keeping the button's percentage current. */
    async #upload(files, run) {
      const total = files.reduce((sum, file) => sum + file.size, 0);
      let sent = 0;
      let shown = 0;
      const ids = [];
      for (const pending of files) {
        const file = this.#files.get(pending.id);
        if (!file) throw new Stopped();
        const id = await uploadFile(this.#adapter.invoke.bind(this.#adapter), file, pending.name, (bytes) => {
          if (run !== this.#uploadRun) throw new Stopped();
          sent += bytes;
          const percent = total ? Math.min(99, Math.floor(sent / total * 100)) : 99;
          if (percent !== shown) {
            shown = percent;
            this.#setCompose({ ...this.#compose, uploading: percent });
          }
        });
        if (run !== this.#uploadRun) throw new Stopped();
        ids.push(id);
      }
      return ids;
    }
    #typing() {
      const active = this.#host.shadowRoot?.activeElement;
      return active?.tagName === "INPUT" && this.#card.contains(active);
    }
    /** Says `text` to screen readers once; the same text again is not repeated. */
    #say(text) {
      if (this.#live.textContent !== text) this.#live.textContent = text;
    }
    /**
     * A child codexhost had not answered for in time shows up in its parent's view, linked: the card
     * says it opened, and what was typed and attached for it goes, as when codexhost answers at once.
     */
    #linked(threadId, view) {
      const awaiting = this.#awaiting;
      if (!awaiting || awaiting.threadId !== threadId) return;
      const { target } = awaiting;
      let text = "";
      try {
        text = cleanText(target.text);
      } catch {
      }
      const spinoff = view.spinoffs.find(
        (item) => item.state === "spawned" && item.childThreadId && ("spinoffId" in target ? item.id === target.spinoffId : item.text === text)
      );
      if (!spinoff?.childThreadId) return;
      this.#awaiting = null;
      if (this.#shown?.threadId !== threadId || awaiting.run !== this.#uploadRun) return;
      const childHost = this.#onHost(threadId).hostId;
      const opened = { ok: true, childThreadId: spinoff.childThreadId, title: target.text, ...childHost ? { hostId: childHost } : {} };
      if ("spinoffId" in target) {
        const { result: _previous, uploading: _uploading, ...rest } = this.#compose;
        this.#compose = { ...rest, busy: false, armed: null, result: opened };
      } else {
        this.#files.clear();
        this.#compose = { ...COMPOSE_IDLE, result: opened };
      }
    }
    #setCompose(next) {
      this.#compose = next;
      this.#renderCard(false, true);
    }
    /** The first click arms the button for a few seconds; a second click opens the child conversation. */
    #spawn(target, key) {
      const shown = this.#shown;
      if (!shown || this.#compose.busy) return;
      clearTimeout(this.#armTimer);
      if (this.#compose.armed !== key) {
        const { result: _previous, ...rest } = this.#compose;
        this.#setCompose({ ...rest, armed: key });
        this.#armTimer = setTimeout(() => {
          if (this.#compose.armed === key && !this.#compose.busy) this.#setCompose({ ...this.#compose, armed: null });
        }, CONFIRM_MS2);
        return;
      }
      const threadId = shown.threadId;
      const host = this.#onHost(threadId);
      const files = "spinoffId" in target || host.hostId ? [] : this.#compose.files;
      const run = this.#uploadRun;
      const { notice: _notice, ...composing } = this.#compose;
      this.#setCompose({ ...composing, busy: true, ...files.length ? { uploading: 0 } : {} });
      Promise.resolve().then(() => files.length ? this.#upload(files, run) : []).then((attachments) => {
        if (attachments.length) {
          const { uploading: _done, ...rest } = this.#compose;
          this.#setCompose(rest);
        }
        const params = "spinoffId" in target ? { threadId, spinoffId: target.spinoffId, ...host } : { threadId, text: target.text, ...attachments.length ? { attachments } : {}, ...host };
        return this.#adapter.invoke("spawn", params);
      }).then((result) => {
        const answer = result;
        const childThreadId = answer?.childThreadId;
        if (typeof childThreadId !== "string" || !childThreadId) throw new Error(this.#strings().badResponse);
        if (this.#shown?.threadId !== threadId || run !== this.#uploadRun) return;
        this.#awaiting = null;
        const childHost = typeof answer?.hostId === "string" ? answer.hostId : host.hostId;
        const opened = { ok: true, childThreadId, title: target.text, ...childHost ? { hostId: childHost } : {} };
        if ("spinoffId" in target) {
          const { result: _previous, uploading: _uploading, ...rest } = this.#compose;
          this.#setCompose({ ...rest, busy: false, armed: null, result: opened });
        } else {
          this.#files.clear();
          this.#setCompose({ ...COMPOSE_IDLE, result: opened });
        }
      }).catch((error) => {
        if (error instanceof Stopped || this.#shown?.threadId !== threadId || run !== this.#uploadRun) return;
        const { result: _previous, uploading: _uploading, ...rest } = this.#compose;
        if (errorCodeOf(error) === "PENDING") {
          this.#awaiting = { threadId, target, run };
          this.#setCompose({ ...rest, busy: false, armed: null, result: { ok: false, pending: true, message: this.#strings().spawnPending } });
          return;
        }
        this.#setCompose({ ...rest, busy: false, armed: null, result: { ok: false, message: shortError(error, this.#strings()) } });
      }).finally(() => {
        void this.#controller.refresh();
        if (this.#shown && !this.#row && !this.#overCard && !this.#overBeside) this.#scheduleHide();
      });
    }
    /**
     * Follows the host's own preview that the card sits beside: the pointer crosses it on the way
     * from the row to the card, so being on it keeps the card.
     */
    #bridge(element) {
      if (element === (this.#beside?.element ?? null)) return;
      this.#beside?.stop();
      this.#beside = null;
      this.#overBeside = false;
      if (!element) return;
      const enter = () => {
        this.#overBeside = true;
        this.#cancelHide();
      };
      const leave = () => {
        this.#overBeside = false;
        if (!this.#row && !this.#overCard) this.#scheduleHide();
      };
      element.addEventListener("pointerenter", enter);
      element.addEventListener("pointerleave", leave);
      this.#beside = {
        element,
        stop: () => {
          element.removeEventListener("pointerenter", enter);
          element.removeEventListener("pointerleave", leave);
        }
      };
    }
    #cancelHide() {
      clearTimeout(this.#hideTimer);
      this.#hideTimer = void 0;
    }
    /** Keeps the card, the badge and the bells on their rows while the sidebar scrolls; other scrolling is ignored. */
    #onScroll(event) {
      const element = this.#shown?.element ?? this.#row?.element ?? (this.#news.size ? this.#sidebar : null);
      if (!element || this.#framePending) return;
      const target = event?.target;
      if (target instanceof Node && target !== this.#doc && !target.contains(element) && !(this.#news.size && this.#sidebar?.contains(target))) return;
      this.#framePending = true;
      const run = () => {
        this.#framePending = false;
        if (this.#stopped) return;
        this.#reposition();
        this.#placeMarkers(this.#summaryOverList);
      };
      if (typeof this.#win.requestAnimationFrame === "function") this.#win.requestAnimationFrame(run);
      else setTimeout(run, 16);
    }
    #reposition() {
      const shown = this.#shown;
      if (shown?.element.isConnected && this.#sidebar) {
        const row = boxOf2(shown.element);
        const area = boxOf2(this.#sidebar);
        if (area.height > 0 && (row.bottom <= area.top || row.top >= area.bottom)) this.#hide();
        else this.#placeCard();
      }
      if (this.#row) this.#renderBadge();
    }
    /** Hides everything at once, as when the page goes to the background. */
    #reset() {
      this.#hide();
      clearTimeout(this.#prefetchTimer);
      this.#row = null;
      this.#pointerThread = null;
      this.#badge.hidden = true;
      if (!this.#list.hidden) this.#closeList(false);
      this.#suppress();
    }
    // -------------------------------------------------------------------------------------------
    // Data
    #onVersion(version) {
      if (this.#stopped || version === this.#version) return;
      this.#version = version;
      this.#generation += 1;
      this.#stale = this.#cache;
      this.#cache = /* @__PURE__ */ new Map();
      this.#errors.clear();
      this.#pending.clear();
      if (this.#shown) this.#load(this.#shown.threadId);
      if (this.#row) this.#load(this.#row.threadId);
    }
    #viewOf(threadId) {
      return this.#cache.get(threadId) ?? this.#stale.get(threadId);
    }
    #load(threadId) {
      if (this.#stopped || this.#cache.has(threadId) || this.#pending.has(threadId)) return;
      const generation = this.#generation;
      const token = {};
      this.#pending.set(threadId, token);
      let request;
      try {
        request = Promise.resolve(this.#adapter.invoke("conversation", { threadId, ...this.#onHost(threadId) }));
      } catch (error) {
        request = Promise.reject(error);
      }
      request.then(
        (result) => this.#settle(threadId, generation, token, isConversationView(result) ? result : new Error(this.#strings().badResponse)),
        (error) => this.#settle(threadId, generation, token, error instanceof Error ? error : new Error(String(error)))
      ).catch((error) => console.warn("[mainline] hover card", error));
    }
    #settle(threadId, generation, token, outcome) {
      if (this.#pending.get(threadId) === token) this.#pending.delete(threadId);
      if (this.#stopped) return;
      if (generation !== this.#generation) {
        if (outcome instanceof Error || this.#cache.has(threadId)) return;
        this.#stale.set(threadId, outcome);
      } else if (outcome instanceof Error) this.#errors.set(threadId, shortError(outcome, this.#strings()));
      else {
        this.#linked(threadId, outcome);
        this.#cache.delete(threadId);
        this.#cache.set(threadId, outcome);
        if (this.#cache.size > CACHE_LIMIT) {
          const oldest = this.#cache.keys().next().value;
          if (oldest !== void 0) this.#cache.delete(oldest);
        }
        this.#stale.delete(threadId);
        this.#errors.delete(threadId);
      }
      if (this.#shown?.threadId === threadId) this.#renderCard();
      if (this.#row?.threadId === threadId) this.#renderBadge();
    }
    // -------------------------------------------------------------------------------------------
    // Drawing
    #strings() {
      return hoverStrings(hoverLocale(this.#doc));
    }
    /** Puts the overlay under body (again, if the host replaced body's children) in the sidebar's light or dark. */
    #mount() {
      if (!this.#host.isConnected) (this.#doc.body ?? this.#doc.documentElement).append(this.#host);
      let scheme;
      try {
        scheme = detectScheme(this.#doc, this.#sidebar);
      } catch {
        scheme = "light";
      }
      if (this.#root.getAttribute("data-scheme") !== scheme) this.#root.setAttribute("data-scheme", scheme);
    }
    #show(hit) {
      clearTimeout(this.#showTimer);
      this.#showTimer = void 0;
      this.#cancelHide();
      const switching = this.#shown?.threadId !== hit.threadId;
      this.#shown = hit;
      if (switching) {
        this.#expanded.clear();
        this.#rendered = null;
        clearTimeout(this.#armTimer);
        this.#uploadRun += 1;
        this.#files.clear();
        this.#compose = COMPOSE_IDLE;
        this.#awaiting = null;
      }
      this.#mount();
      this.#card.hidden = false;
      this.#suppress();
      this.#renderCard(switching);
      this.#load(hit.threadId);
    }
    #hide() {
      clearTimeout(this.#showTimer);
      this.#showTimer = void 0;
      this.#cancelHide();
      this.#overCard = false;
      this.#bridge(null);
      clearTimeout(this.#armTimer);
      clearTimeout(this.#dragTimer);
      this.#card.removeAttribute("data-dragging");
      this.#uploadRun += 1;
      this.#files.clear();
      this.#picking = false;
      this.#compose = COMPOSE_IDLE;
      this.#awaiting = null;
      this.#say("");
      this.#renderLater = false;
      this.#summaryRefused = null;
      this.#summaryFailed = null;
      if (!this.#shown) {
        this.#suppress();
        return;
      }
      this.#shown = null;
      this.#rendered = null;
      this.#card.hidden = true;
      this.#card.replaceChildren();
      this.#suppress();
    }
    /** Rebuilds the card when what it shows changed; `force` also while the user types in it. */
    #renderCard(fromTop = false, force = false) {
      const shown = this.#shown;
      if (!shown) return;
      const typing = this.#typing();
      if (typing && !force) {
        this.#renderLater = true;
        this.#placeCard();
        return;
      }
      const threadId = shown.threadId;
      const view = this.#viewOf(threadId);
      const error = this.#errors.get(threadId);
      const content = view ? { kind: "view", view } : error !== void 0 ? { kind: "error", message: error } : { kind: "loading" };
      const t = this.#strings();
      const result = this.#compose.result;
      this.#say(this.#compose.armed !== null && !this.#compose.busy ? t.armed(t.spawnChild) : result && !result.ok && result.pending ? result.message : "");
      const { text: _typed, ...compose2 } = this.#compose;
      const asked = this.#summarizing.get(threadId);
      const summarizing = asked !== void 0 && (view?.summary?.at ?? 0) < asked && Date.now() - asked < 3 * 6e4;
      if (asked !== void 0 && !summarizing) this.#summarizing.delete(threadId);
      const refused = this.#summaryRefused === threadId;
      const failed = this.#summaryFailed?.threadId === threadId ? this.#summaryFailed.message : void 0;
      const remote = this.#remote(threadId);
      const key = `${t.locale}|${[...this.#expanded].sort().join(",")}|${JSON.stringify(compose2)}|${summarizing}|${refused}|${failed ?? ""}|${remote}|${JSON.stringify(content)}`;
      if (this.#rendered?.threadId !== threadId || this.#rendered.key !== key) {
        const scroll = fromTop ? 0 : this.#card.scrollTop;
        let nodes;
        try {
          nodes = cardNodes(content, {
            h: this.#h,
            t,
            now: Date.now(),
            expanded: this.#expanded,
            actions: this.#actions,
            compose: this.#compose,
            summarizing,
            summaryRefused: refused,
            ...failed ? { summaryFailed: failed } : {},
            remote
          });
        } catch (error2) {
          nodes = cardNodes(
            { kind: "error", message: shortError(error2, t) },
            { h: this.#h, t, now: Date.now(), expanded: this.#expanded, actions: this.#actions, compose: this.#compose }
          );
        }
        this.#card.replaceChildren(...nodes);
        this.#card.scrollTop = scroll;
        if (typing) this.#focusField();
        this.#card.setAttribute("aria-label", view?.title ?? t.loading);
        this.#card.setAttribute("data-thread", threadId);
        this.#rendered = { threadId, key };
      }
      this.#placeCard();
    }
    /**
     * A host preview opened or closed: hidden while the card shows (or is about to) for its row, else
     * the card makes room for it; but the card never moves from under the pointer: a preview closing
     * while the user reads the card leaves the card where it is.
     */
    #makeRoom() {
      if (this.#shown && !this.#overCard) this.#placeCard();
    }
    /**
     * Whether the host's own previews are hidden now: while the card shows, unless the pointer is on
     * another conversation's row (the card stays with its own while the user types), and while it is
     * about to show for the row under the pointer. Sets or clears SUPPRESS_ATTRIBUTE on the document
     * root, and restores the host rule once it is off. Never on when the card is not
     * going to show.
     */
    #suppress() {
      const shown = this.#shown;
      const on = !this.#stopped && (shown ? this.#pointerThread === shown.threadId || this.#pointerThread === null && (this.#overCard || !this.#holding()) : this.#showTimer !== void 0 && this.#row !== null && this.#pointerThread === this.#row.threadId);
      if (on !== this.#suppressing) {
        this.#suppressing = on;
        this.#doc.documentElement.toggleAttribute(SUPPRESS_ATTRIBUTE, on);
      }
    }
    #placeCard() {
      const shown = this.#shown;
      if (!shown) return;
      if (shown.element.isConnected) shown.box = boxOf2(shown.element);
      const sidebar = this.#sidebar?.isConnected ? boxOf2(this.#sidebar) : null;
      const popup = hostPopup(this.#doc, shown.box, sidebar, (element) => element === this.#host || element.hasAttribute("data-codexhost-mainline"));
      const size = { width: this.#card.offsetWidth || CARD_WIDTH, height: this.#card.offsetHeight || 0 };
      const viewport = { width: this.#win.innerWidth, height: this.#win.innerHeight };
      if ((this.#overCard || this.#holding()) && this.#card.style.left) {
        this.#card.style.top = `${keepInside(parseFloat(this.#card.style.top) || 0, size.height, viewport)}px`;
        return;
      }
      this.#bridge(popup);
      const spot = cardSpot(shown.box, sidebar, size, viewport, popup ? boxOf2(popup) : null);
      this.#card.toggleAttribute("data-beside", popup !== null);
      if (popup) this.#card.setAttribute("data-beside", popup.closest("[popover]") ? "popover" : "fixed");
      this.#card.style.left = `${spot.left}px`;
      this.#card.style.top = `${spot.top}px`;
    }
    /** Which conversations have unseen GitHub news, from the latest snapshot. */
    #onNews(data) {
      if (this.#stopped || !data) return;
      const news2 = /* @__PURE__ */ new Map();
      for (const ref of data.alerts ?? []) {
        const threadId = ref.origin?.threadId;
        if (threadId) news2.set(threadId, (news2.get(threadId) ?? 0) + 1);
      }
      this.#news = news2;
      this.#alerts = data.alerts ?? [];
      this.#placeMarkers();
    }
    /**
     * A bell on the sidebar row of each conversation with unseen GitHub news, so a maintainer's
     * reply points at the conversation it belongs to; the hovered row shows its card instead. News
     * whose conversation has no row in sight goes to the summary at the top of the sidebar.
     * `relayout`: the summary's place is worked out again even if the sidebar did not move.
     */
    #placeMarkers(relayout = false) {
      if (this.#stopped) return;
      for (const [threadId, marker] of this.#markers)
        if (!this.#news.has(threadId)) {
          marker.remove();
          this.#markers.delete(threadId);
        }
      const t = this.#strings();
      const unplaced = /* @__PURE__ */ new Set();
      for (const [threadId, count] of this.#news) {
        let spot = null;
        for (const row of this.#adapter.rowsFor?.(threadId) ?? []) {
          spot = newsBadgeSpot(row, this.#sidebar);
          if (spot) break;
        }
        if (!spot) unplaced.add(threadId);
        let marker = this.#markers.get(threadId);
        if (!spot || this.#row?.threadId === threadId) {
          if (marker) marker.hidden = true;
          continue;
        }
        if (!marker) {
          this.#mount();
          marker = this.#h("div", { class: "news-marker", attrs: { "data-thread": threadId, "aria-hidden": "true" } });
          this.#root.append(marker);
          this.#markers.set(threadId, marker);
        }
        const label = "\u{1F514}";
        if (marker.textContent !== label) marker.textContent = label;
        marker.setAttribute("data-count", String(count));
        marker.title = t.news;
        marker.style.left = `${spot.x}px`;
        marker.style.top = `${spot.y}px`;
        marker.hidden = false;
      }
      this.#unplaced = this.#alerts.filter((ref) => ref.origin && unplaced.has(ref.origin.threadId));
      this.#placeSummary(relayout);
    }
    /**
     * "🔔 N" at the top of the sidebar, N being the news whose conversation has no row in sight here
     * (in a collapsed group, scrolled away, or not listed): a button that opens the list of it. It
     * sits where it covers none of the host's text or buttons (see summarySpot).
     */
    #placeSummary(relayout) {
      const count = this.#unplaced.length;
      const sidebar = this.#sidebar?.isConnected ? boxOf2(this.#sidebar) : null;
      if (!count || !sidebar || sidebar.width <= 0 || sidebar.height <= 0) {
        if (!this.#list.hidden) this.#closeList(this.#focusIn(this.#list) || this.#focusIn(this.#summary));
        this.#summary.hidden = true;
        this.#summaryFor = "";
        this.#summaryOverList = false;
        return;
      }
      const t = this.#strings();
      const label = t.summary(count);
      if (this.#summary.getAttribute("data-count") !== String(count) || this.#summary.getAttribute("aria-label") !== label) {
        this.#summary.replaceChildren(this.#h("span", { class: "summary-bell", text: "\u{1F514}", attrs: { "aria-hidden": "true" } }), this.#h("span", { text: String(count) }));
        this.#summary.setAttribute("data-count", String(count));
        this.#summary.setAttribute("aria-label", label);
        this.#summary.title = t.summaryTip(count);
      }
      if (this.#summary.hidden) {
        this.#mount();
        this.#summary.hidden = false;
      }
      const viewport = { width: this.#win.innerWidth, height: this.#win.innerHeight };
      const where = [sidebar.left, sidebar.top, sidebar.width, sidebar.height, viewport.width, viewport.height, count, t.locale].join(",");
      if (relayout || where !== this.#summaryFor) {
        this.#summaryFor = where;
        const size = { width: this.#summary.offsetWidth || SUMMARY_SIZE.width, height: this.#summary.offsetHeight || SUMMARY_SIZE.height };
        const bottom = Math.min(sidebar.top + SUMMARY_BAND, sidebar.bottom, viewport.height);
        const area = { left: sidebar.left, right: sidebar.right, top: 0, bottom, width: sidebar.width, height: Math.max(0, bottom) };
        const content = hostContent(
          this.#doc,
          area,
          (element) => element === this.#host || element.matches(OVERLAYS),
          (element) => this.#rowAt(element)?.element === element
        );
        const spot = summarySpot(sidebar, size, viewport, content, this.#adapter.surface === "desktop" ? [WINDOW_BUTTONS] : []);
        this.#summaryOverList = spot.over;
        this.#summary.style.left = `${spot.left}px`;
        this.#summary.style.top = `${spot.top}px`;
      }
      if (!this.#list.hidden) {
        this.#renderList();
        this.#placeList();
      }
    }
    /** Whether the focus is on `element` or in it, within this overlay. */
    #focusIn(element) {
      const active = this.#host.shadowRoot?.activeElement;
      return Boolean(active && (active === element || element.contains(active)));
    }
    #toggleList() {
      if (this.#list.hidden) this.#openList();
      else this.#closeList(true);
    }
    #openList() {
      if (!this.#unplaced.length || this.#summary.hidden) return;
      this.#listShows = "";
      this.#renderList();
      this.#list.hidden = false;
      this.#summary.setAttribute("aria-expanded", "true");
      this.#placeList();
      this.#list.querySelector("button")?.focus();
    }
    /** Closes the list; `focusSummary`: the focus goes back to the summary (it was in the list). */
    #closeList(focusSummary) {
      this.#list.hidden = true;
      this.#list.replaceChildren();
      this.#listShows = "";
      this.#summary.setAttribute("aria-expanded", "false");
      if (focusSummary && !this.#summary.hidden) this.#summary.focus();
    }
    /** Under the summary, or over it where there is no room below; inside the window either way. */
    #placeList() {
      const summary = boxOf2(this.#summary);
      const viewport = { width: this.#win.innerWidth, height: this.#win.innerHeight };
      const width = this.#list.offsetWidth || LIST_WIDTH;
      const height = this.#list.offsetHeight || 0;
      const left = Math.max(8, Math.min(summary.left, viewport.width - 8 - width));
      const below = summary.bottom + LIST_GAP;
      const above = summary.top - LIST_GAP - height;
      const top = below + height <= viewport.height - 8 || above < 8 ? keepInside(below, height, viewport) : above;
      this.#list.style.left = `${Math.round(left)}px`;
      this.#list.style.top = `${Math.round(top)}px`;
    }
    /**
     * The news the summary counts, newest first: repository and number, title, what happened and
     * when, which conversation it came from; "Open conversation" and "Got it" on each.
     */
    #renderList() {
      const t = this.#strings();
      const now = Date.now();
      const shows = JSON.stringify([t.locale, Math.floor(now / 6e4), this.#unplaced.map((ref) => [ref.key, ref.title, ref.activity, ref.origin])]);
      if (shows === this.#listShows) return;
      this.#listShows = shows;
      const active = this.#host.shadowRoot?.activeElement;
      const focused = active && this.#list.contains(active) ? active.getAttribute("data-key") : null;
      const index = focused ? this.#unplacedIndex(focused) : -1;
      const h = this.#h;
      this.#list.setAttribute("aria-label", t.news);
      this.#list.replaceChildren(
        h("div", { class: "section-title" }, h("span", { text: t.news })),
        h("ul", { class: "news-items" }, ...this.#unplaced.map((ref) => this.#listItem(ref, t, now)))
      );
      if (!focused) return;
      const kind = focused.split(":")[0];
      const again = this.#list.querySelector(`[data-key="${quoted(focused)}"]`) ?? [...this.#list.querySelectorAll(`[data-key^="${kind}:"]`)][Math.min(Math.max(index, 0), this.#unplaced.length - 1)] ?? this.#list.querySelector("button");
      if (again) again.focus();
      else this.#summary.focus();
    }
    /** Where a button's piece of news was in the list last drawn. */
    #unplacedIndex(key) {
      const items = [...this.#list.querySelectorAll(".news-item")];
      return items.findIndex((item) => item.querySelector(`[data-key="${quoted(key)}"]`) !== null);
    }
    #listItem(ref, t, now) {
      const h = this.#h;
      const origin = ref.origin;
      const conversation = origin ? origin.title ?? `#${origin.threadId.slice(0, 8)}` : "";
      return h(
        "li",
        { class: "news-item", attrs: { "data-ref": ref.key } },
        h(
          "div",
          { class: "news-item-head" },
          h("span", { class: "ref-number", text: `${ref.repo}#${ref.number}` }),
          ref.title ? h("span", { class: "ref-title", text: ref.title, title: ref.title }) : null
        ),
        ref.activity ? h("div", { class: "news-item-meta", text: `${t.reason(ref.activity.reason)} \xB7 ${t.time(ref.activity.at, now)}`, title: t.date(ref.activity.at) }) : null,
        origin ? h("div", { class: "news-item-meta", text: t.fromConversation(conversation, origin.turn) }) : null,
        h(
          "div",
          { class: "news-item-actions" },
          origin ? h("button", { class: "btn small", text: t.openConversation, attrs: { type: "button", "data-key": `open:${ref.key}` }, on: { click: () => this.#openFromList(ref) } }) : null,
          h("button", { class: "btn small", text: t.seen, attrs: { type: "button", "data-key": `seen:${ref.key}` }, on: { click: () => this.#seenFromList(ref) } })
        )
      );
    }
    /** Opens the conversation a piece of news came from, once its news is marked seen (opening may reload the page). */
    #openFromList(ref) {
      const threadId = ref.origin?.threadId;
      if (!threadId) return;
      const hostId = ref.origin?.hostId ?? this.#onHost(threadId).hostId;
      this.#closeList(false);
      const seen = Promise.resolve().then(() => this.#adapter.invoke("refs.seen", { key: ref.key })).catch(() => void 0);
      void Promise.race([seen, new Promise((resolve) => setTimeout(resolve, SEEN_WAIT_MS))]).then(() => {
        if (this.#stopped) return;
        try {
          if (hostId) this.#adapter.openThread(threadId, hostId);
          else this.#adapter.openThread(threadId);
        } catch (error) {
          console.warn("[mainline] could not open the conversation", error);
        }
        void this.#controller.refresh();
      });
    }
    #seenFromList(ref) {
      void Promise.resolve().then(() => this.#adapter.invoke("refs.seen", { key: ref.key })).then(() => this.#controller.refresh()).catch(() => void 0);
    }
    /** "◆ reached/total" beside the hovered row's own buttons, for conversations with milestones. */
    #renderBadge() {
      const row = this.#row;
      const progress = row ? this.#viewOf(row.threadId)?.progress : void 0;
      if (!row || !progress || !(progress.total > 0) || !row.element.isConnected) {
        this.#badge.hidden = true;
        return;
      }
      const spot = badgeSpot(row.element, this.#sidebar);
      if (!spot) {
        this.#badge.hidden = true;
        return;
      }
      if (this.#badge.hidden) this.#mount();
      const text = `${progress.done}/${progress.total}`;
      if (this.#badge.getAttribute("data-progress") !== text) {
        this.#badge.replaceChildren(this.#h("span", { class: "diamond", text: "\u25C6" }), this.#h("span", { class: "count", text }));
        this.#badge.setAttribute("data-progress", text);
      }
      this.#badge.toggleAttribute("data-complete", progress.done >= progress.total);
      this.#badge.setAttribute("data-thread", row.threadId);
      this.#badge.style.left = `${spot.x}px`;
      this.#badge.style.top = `${spot.y}px`;
      this.#badge.hidden = false;
    }
  };

  // src/ui/band.ts
  var CONTROLS2 = "button, a, input, select, textarea, svg, img, canvas, video, [role='button'], [role='tab']";
  function freeBand(container) {
    if (!container) return null;
    const bar = container.getBoundingClientRect();
    if (bar.width <= 0 || bar.height < 28) return null;
    const doc = container.ownerDocument;
    const spans = [];
    const add = (rect) => {
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
      const text = range.getBoundingClientRect();
      const clip = node.parentElement?.getBoundingClientRect();
      if (!clip) add(text);
      else {
        const left = Math.max(text.left, clip.left);
        const right = Math.min(text.right, clip.right);
        if (right > left) add({ ...text.toJSON?.(), left, right, width: right - left, top: text.top, bottom: text.bottom, height: text.height });
      }
    }
    for (const element of container.querySelectorAll(CONTROLS2)) add(element.getBoundingClientRect());
    spans.sort((a, b) => a[0] - b[0]);
    let best = null;
    let cursor = bar.left;
    const consider = (left, right) => {
      if (right - left > (best ? best[1] - best[0] : 0)) best = [left, right];
    };
    for (const [left, right] of spans) {
      if (left > cursor) consider(cursor, left);
      cursor = Math.max(cursor, right);
    }
    consider(cursor, bar.right);
    const found = best;
    return found ? { left: found[0], right: found[1], top: bar.top, height: bar.height } : null;
  }

  // src/desktop/adapter.ts
  var COMPOSER_ATTRIBUTE = "data-above-composer-conversation-id";
  var ACTIVE_ROW_ATTRIBUTE = "data-app-action-sidebar-thread-active";
  var HEADER_SELECTOR = "[data-app-shell-header-toolbar]";
  var SIDEBAR_SELECTOR = "[data-app-action-sidebar-scroll]";
  var NATIVE_ROW_SELECTOR = "[data-app-action-sidebar-thread-row]";
  var TREE_ROW_ATTRIBUTE = "data-codexhost-sidebar-tree-node";
  var OPEN_EVENT = "codexhost-mainline:open-thread";
  var CHECK_DELAY_MS = 200;
  var SAFETY_CHECK_MS = 1500;
  var REPORT_EVERY_MS = 2e3;
  var REPORT_AGAIN_MS = 1e4;
  var HEARTBEAT_MS = 5e3;
  var laidOut = (element) => (element?.getClientRects().length ?? 0) > 0;
  function closeSettings(view) {
    const shell = view?.__codexhostSettingsShellV1;
    if (!shell?.open || typeof shell.close !== "function") return false;
    shell.close();
    return true;
  }
  function openComposer(doc) {
    const shown = [];
    const all = [];
    let draftShown = false;
    for (const element of doc.querySelectorAll(`[${COMPOSER_ATTRIBUTE}]`)) {
      const threadId = element.getAttribute(COMPOSER_ATTRIBUTE);
      const visible = laidOut(element) || laidOut(element.parentElement);
      if (isDraftId(threadId) && visible) draftShown = true;
      if (!isThreadId(threadId)) continue;
      all.push({ threadId, element });
      if (visible) shown.push({ threadId, element });
    }
    if (draftShown && !shown.length) return null;
    const candidates = shown.length ? shown : all;
    const ids = new Set(candidates.map(({ threadId }) => threadId));
    return ids.size === 1 ? candidates[0] : void 0;
  }
  function currentDesktopThread(doc, rows) {
    const composer = openComposer(doc);
    if (composer !== void 0) return composer?.threadId ?? null;
    for (const row of rows)
      if (row.isLocal && isThreadId(row.threadId) && row.element.getAttribute(ACTIVE_ROW_ATTRIBUTE) === "true") return row.threadId;
    return null;
  }
  function desktopHeader(doc) {
    const toolbar = doc.querySelector(HEADER_SELECTOR);
    for (let node = toolbar; node && node !== doc.body; node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (rect.height > 80) break;
      if (rect.width >= 480 && rect.height >= 28) return node;
    }
    return null;
  }
  function desktopBand(doc) {
    return freeBand(desktopHeader(doc));
  }
  function desktopAnchor(doc) {
    const view = doc.defaultView;
    if (!view) return null;
    const header = doc.querySelector(HEADER_SELECTOR);
    const headerBottom = header?.getBoundingClientRect().bottom ?? 0;
    const top = headerBottom > 0 ? headerBottom + 8 : 56;
    const composer = openComposer(doc)?.element;
    const column = composer?.parentElement ?? composer;
    const rect = column?.getBoundingClientRect();
    const band = desktopBand(doc);
    if (rect && rect.width > 0) return { x: rect.left + rect.width / 2, top, band };
    return { x: view.innerWidth / 2, top, band };
  }
  function treeReport(tree, data, current) {
    const parents = {};
    const ids = new Set(Object.keys(data?.state.conversations ?? {}));
    if (current) ids.add(current);
    for (const [child, parent] of Object.entries(tree.parents)) {
      if (tree.nodes[child]?.archived) continue;
      parents[child] = parent;
      ids.add(child);
      ids.add(parent);
    }
    const nodes = {};
    for (const id of ids) {
      const node = tree.nodes[id];
      if (!node) continue;
      const status = node.status;
      nodes[id] = { status, harnessId: node.harnessId, ...node.title ? { title: node.title } : {} };
    }
    return { nodes, parents };
  }
  function createDesktopAdapter(api, doc = document) {
    const view = doc.defaultView;
    let rows = [];
    let rowIds = /* @__PURE__ */ new WeakMap();
    const rememberRows = (next) => {
      rowIds = /* @__PURE__ */ new WeakMap();
      for (const row of next) if (row.isLocal && isThreadId(row.threadId)) rowIds.set(row.element, row.threadId);
    };
    let tree;
    let latest;
    let current = null;
    let reportTimer;
    let lastReport = "";
    let lastReportAt = 0;
    const invoke = (method, params) => api.backend.invoke(method, params);
    const report = () => {
      reportTimer = void 0;
      if (!tree || api.signal.aborted) return;
      const payload = treeReport(tree, latest, current);
      const key = JSON.stringify(payload);
      if (key === lastReport && Date.now() - lastReportAt < REPORT_AGAIN_MS) return;
      lastReport = key;
      lastReportAt = Date.now();
      void invoke("reportTree", payload).catch(() => {
        lastReport = "";
      });
    };
    const scheduleReport = () => {
      reportTimer ??= setTimeout(report, REPORT_EVERY_MS);
    };
    const heartbeat = setInterval(() => {
      if (doc.visibilityState !== "hidden" && !reportTimer) report();
    }, HEARTBEAT_MS);
    const open = async (threadId) => {
      await api.navigate.openThread(threadId);
      closeSettings(view);
    };
    const openThread = (threadId) => {
      void open(threadId).catch((error) => {
        if (!api.signal.aborted) console.warn("[mainline] could not open the window", error);
      });
    };
    const onOpenRequest = (event) => {
      const detail = event.detail;
      if (!detail || typeof detail.threadId !== "string") return;
      detail.handled = true;
      detail.result = open(detail.threadId);
    };
    view?.addEventListener(OPEN_EVENT, onOpenRequest);
    const stopTree = api.threads.watchTree((next) => {
      tree = next;
      scheduleReport();
    });
    return {
      surface: "desktop",
      doc,
      invoke,
      openThread,
      anchor: () => desktopAnchor(doc),
      mount: (host) => api.dom.mount(host, doc.body),
      onData(data, threadId) {
        latest = data;
        current = threadId;
        scheduleReport();
      },
      watchCurrentThread(onChange) {
        let pending;
        const check = () => {
          pending = void 0;
          current = currentDesktopThread(doc, rows);
          onChange(current);
        };
        const schedule = () => {
          pending ??= setTimeout(check, CHECK_DELAY_MS);
        };
        const stopRows = api.sidebar.observeRows((next) => {
          rows = next;
          rememberRows(next);
          schedule();
        });
        const observer = view ? new view.MutationObserver(schedule) : void 0;
        observer?.observe(doc.documentElement, {
          attributes: true,
          attributeFilter: [COMPOSER_ATTRIBUTE, ACTIVE_ROW_ATTRIBUTE],
          childList: true,
          subtree: true
        });
        const safety = setInterval(schedule, SAFETY_CHECK_MS);
        check();
        return () => {
          stopRows();
          observer?.disconnect();
          clearInterval(safety);
          clearTimeout(pending);
        };
      },
      sidebar: () => doc.querySelector(SIDEBAR_SELECTOR),
      rowsFor(threadId) {
        const found = [];
        for (const tree2 of doc.querySelectorAll(`[${TREE_ROW_ATTRIBUTE}]`))
          if (tree2.getAttribute(TREE_ROW_ATTRIBUTE) === threadId) found.push(tree2);
        for (const row of rows) if (row.threadId === threadId && row.isConnected()) found.push(row.element);
        return found;
      },
      rowAt(target) {
        const element = target instanceof Element ? target : null;
        const tree2 = element?.closest(`[${TREE_ROW_ATTRIBUTE}]`);
        const treeId = tree2?.getAttribute(TREE_ROW_ATTRIBUTE);
        if (tree2 && isThreadId(treeId)) return { element: tree2, threadId: treeId };
        for (let node = element; node && node !== doc.body; node = node.parentElement) {
          const threadId = rowIds.get(node);
          if (threadId) return { element: node, threadId };
          if (node.matches(NATIVE_ROW_SELECTOR)) break;
        }
        const native = element?.closest(NATIVE_ROW_SELECTOR);
        const nativeId = native ? rowIds.get(native) : void 0;
        return native && nativeId ? { element: native, threadId: nativeId } : null;
      },
      // Measures much of the page: called only while this surface's diagnostics are on (`diagnosticsOn`).
      describe() {
        const box = (element) => {
          const rect = element?.getBoundingClientRect();
          return rect ? [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)] : null;
        };
        const composer = openComposer(doc);
        const toolbar = doc.querySelector(HEADER_SELECTOR);
        const header = desktopHeader(doc);
        const band = desktopBand(doc);
        return {
          thread: current?.slice(0, 8) ?? null,
          via: composer ? "composer" : current ? "row" : "none",
          composers: doc.querySelectorAll(`[${COMPOSER_ATTRIBUTE}]`).length,
          rows: rows.length,
          toolbar: box(toolbar),
          header: header ? { tag: header.tagName.toLowerCase(), box: box(header) } : null,
          band: band ? [Math.round(band.left), Math.round(band.right)] : null,
          viewport: view ? [view.innerWidth, view.innerHeight] : null,
          anchor: (() => {
            const anchor = desktopAnchor(doc);
            return anchor ? [Math.round(anchor.x), Math.round(anchor.top)] : null;
          })(),
          composer: box(composer?.element),
          column: box(composer?.element.parentElement),
          zoom: view ? [view.getComputedStyle(doc.documentElement).zoom, doc.body ? view.getComputedStyle(doc.body).zoom : null, view.devicePixelRatio] : null,
          host: (() => {
            const host = doc.querySelector("[data-codexhost-mainline]");
            return host ? [host.style.left, host.style.top, host.parentElement?.tagName.toLowerCase() ?? null] : null;
          })(),
          // Whether the sidebar hover card can find conversation rows.
          sidebar: (() => {
            const sidebar = doc.querySelector(SIDEBAR_SELECTOR);
            if (!sidebar) return null;
            return {
              box: box(sidebar),
              rows: rows.filter((row) => sidebar.contains(row.element)).length,
              treeRows: sidebar.querySelectorAll(`[${TREE_ROW_ATTRIBUTE}]`).length,
              hover: (() => {
                const card = doc.querySelector("[data-codexhost-mainline-hover]")?.shadowRoot?.querySelector(".card");
                if (!card) return "idle";
                if (card.hidden) return "mounted";
                return { card: box(card), beside: card.getAttribute("data-beside") };
              })(),
              // GitHub news badges, and the icon of the row each one belongs to.
              news: [...doc.querySelector("[data-codexhost-mainline-hover]")?.shadowRoot?.querySelectorAll(".news-marker:not([hidden])") ?? []].map((marker) => {
                const threadId = marker.getAttribute("data-thread") ?? "";
                const row = rows.find((item) => item.threadId === threadId)?.element ?? doc.querySelector(`[${TREE_ROW_ATTRIBUTE}="${threadId}"]`);
                const icon2 = row ? leadingIcon(row) : null;
                return { at: [marker.style.left, marker.style.top], row: box(row), icon: icon2 ? [Math.round(icon2.left), Math.round(icon2.top), Math.round(icon2.width)] : null };
              }),
              // "🔔 N": news whose conversation has no row in sight, and where it sits.
              summary: (() => {
                const summary = doc.querySelector("[data-codexhost-mainline-hover]")?.shadowRoot?.querySelector(".summary:not([hidden])");
                return summary ? { count: summary.getAttribute("data-count"), at: [summary.style.left, summary.style.top] } : null;
              })()
            };
          })()
        };
      },
      dispose() {
        clearTimeout(reportTimer);
        clearInterval(heartbeat);
        stopTree();
        view?.removeEventListener(OPEN_EVENT, onOpenRequest);
      }
    };
  }

  // src/desktop/entry.ts
  define({
    activate(api) {
      const adapter = createDesktopAdapter(api);
      const controller = startController(adapter);
      const stopHover = startHover(adapter, controller);
      const stopFavorites = startFavorites(adapter, controller);
      return () => {
        stopFavorites();
        stopHover();
        controller.dispose();
      };
    }
  });
})();
