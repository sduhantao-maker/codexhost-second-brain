/**
 * Made-up demo data for the README images: an online shop project (`acme/shop-web`), in Chinese
 * and in English. Nothing here comes from a real conversation; every title, request, milestone,
 * PR and issue is fictional, and the thread ids are invented.
 */
import type { Conversation, StateV2 } from "../../src/core/conversation.js";
import type { Favorite } from "../../src/core/favorites.js";
import { DEFAULT_SETTINGS, type Locale, type Settings, type ThreadInfo } from "../../src/core/model.js";
import { refKey, type Ref, type RefIndex, type ScanRecord } from "../../src/core/refs.js";

export const REPO = "acme/shop-web";

/** Invented thread ids, one per demo conversation. */
export const IDS = {
  login: "7c1e4b2a-5d3f-4e8a-9b61-2f0c8d7a3e15",
  ipad: "e5d24c87-1f6a-4b39-8e0d-7a3c5b9f2614",
  coupon: "3a9f6e21-8b4c-4d07-a2e5-6c1b9f0d4a72",
  payment: "b84f1d09-2c7e-4a65-9f13-0d6e8a2c5b47",
  search: "5b0e9d72-3f4a-4c18-8d26-1e7b4a9c0f53",
  docs: "d9f05b3e-4a8c-4e62-a1d7-2c6e9b4f8a05",
  export: "c2b6e8f4-7a1d-4c95-8e37-5b0f2d9a6c13",
  lazyload: "91d7a3c5-6e2b-4f80-b4a9-3e5f7c1d8062",
  perf: "4e8a2d6f-9c3b-4a17-b5e0-8d1f6c2a9e34",
} as const;

type Key = keyof typeof IDS;

export interface SidebarRow {
  threadId: string;
  /** codexhost's own title of the conversation, as its sidebar shows it. */
  title: string;
}

export interface SidebarGroup {
  workspace: string;
  rows: SidebarRow[];
}

export interface Demo {
  locale: Locale;
  now: number;
  state: StateV2;
  info: Record<string, ThreadInfo>;
  /** Delegation links, child to parent. */
  parents: Record<string, string>;
  index: RefIndex;
  favorites: Favorite[];
  settings: Settings;
  sidebar: SidebarGroup[];
  /** The conversation open beside the hover card (the hero image), only sketched there. */
  open: { threadId: string; title: string };
  /** The conversation a passage is selected in (saving a reply). */
  save: { threadId: string; title: string; user: string; reply: string[]; passage: string };
  /** The mock host's words around the extension: its new-conversation button, composer, selection toolbar and the overview page's tab. */
  host: { newChat: string; composer: string; addToChat: string; annotate: string; page: string };
}

/** The words of one language. */
interface Words {
  host: Demo["host"];
  sidebar: Record<Key, string>;
  titles: Record<Exclude<Key, "perf">, string>;
  tags: Record<Exclude<Key, "perf">, string[]>;
  login: { milestones: [string, string, string, string]; tasks: [string, string, string, string, string, string]; doing: string; spinoff: string };
  ipad: { milestones: [string, string]; tasks: [string]; doing: string };
  coupon: { milestones: [string, string, string]; tasks: [string, string]; doing: string };
  payment: { milestones: [string, string, string, string]; tasks: [string, string] };
  search: { milestones: [string, string, string]; tasks: [string] };
  docs: { milestones: [string, string, string]; tasks: [string, string] };
  export: { milestones: [string, string, string] };
  lazyload: { milestones: [string, string, string] };
  prompts: { login: string; coupon: string; perf: string };
  firstPrompts: Record<Key, string>;
  refs: { pr42: string; issue39: string; pr45: string; issue38: string; pr31: string };
  /** The user's message, and the reply: its first paragraph is the passage selected and saved. */
  save: { user: string; reply: [string, string, string] };
  favorites: { note: string; chat: string; mine: string };
}

const ZH: Words = {
  host: { newChat: "新对话", composer: "继续对话…", addToChat: "添加到对话", annotate: "添加批注", page: "第二大脑" },
  sidebar: {
    login: "登录页在手机上错位",
    ipad: "检查 iPad 横屏",
    coupon: "购物车加优惠券",
    payment: "升级支付 SDK",
    search: "搜索支持拼音",
    docs: "更新部署文档",
    export: "订单导出 CSV",
    lazyload: "商品图懒加载",
    perf: "首页性能检查",
  },
  titles: {
    login: "修复登录页在窄屏下错位",
    ipad: "检查 iPad 横屏下的登录页",
    coupon: "购物车结算加优惠券",
    payment: "升级支付 SDK 到 v3",
    search: "商品搜索支持拼音",
    docs: "更新部署文档",
    export: "订单列表导出 CSV",
    lazyload: "商品详情页图片懒加载",
  },
  tags: {
    login: ["shop-web", "登录页", "响应式", "PR #42"],
    ipad: ["shop-web", "登录页", "iPad"],
    coupon: ["shop-web", "购物车", "优惠券", "Issue #38"],
    payment: ["shop-web", "支付", "PR #45"],
    search: ["shop-web", "搜索", "拼音"],
    docs: ["docs-site", "部署"],
    export: ["shop-web", "订单", "CSV"],
    lazyload: ["shop-web", "性能", "PR #31"],
  },
  login: {
    milestones: ["复现问题并找到原因", "提交 PR #42", "处理评审意见", "合并并验证线上"],
    tasks: ["在 375px 宽度下复现", "定位到表单的 flex 换行", "改用 CSS Grid 排表单", "补窄屏截图测试", "调整按钮间距", "检查 iPad 横屏"],
    doing: "回复评审并更新截图",
    spinoff: "注册页也有同样的错位",
  },
  ipad: { milestones: ["列出要检查的屏幕宽度", "对比三种宽度的截图"], tasks: ["截 1024px 横屏"], doing: "对比 768、1024、1366 三种宽度" },
  coupon: { milestones: ["确定优惠券规则", "接入优惠券接口", "结算页展示优惠明细"], tasks: ["写 applyCoupons", "过期券给出提示"], doing: "过期券给出提示" },
  payment: { milestones: ["评估 v3 的改动", "替换下单和退款接口", "提交 PR #45", "合并上线"], tasks: ["更新回调地址", "跑完支付回归测试"] },
  search: { milestones: ["选定拼音分词库", "建索引", "搜索框联想"], tasks: ["对比两个分词库"] },
  docs: { milestones: ["整理现有步骤", "补上回滚说明", "请运维同事审阅"], tasks: ["写清环境变量", "补回滚命令"] },
  export: { milestones: ["确定导出字段", "后台生成 CSV", "大文件分批下载"] },
  lazyload: { milestones: ["找出首屏大图", "接入懒加载", "提交 PR #31"] },
  prompts: {
    login: "评审说按钮间距再大一点，改完把截图也更新一下",
    coupon: "过期的券现在直接报错，改成给个提示",
    perf: "首页打开有点慢，帮我看看是哪里拖慢的",
  },
  firstPrompts: {
    login: "登录页在手机上按钮错位了，帮我看看是什么原因",
    ipad: "检查登录页在 iPad 横屏下有没有同样的问题",
    coupon: "结算页要支持优惠券，满减和折扣都要有",
    payment: "支付 SDK 要升级到 v3，先看看有哪些不兼容的改动",
    search: "商品搜索要支持拼音，输入 xie 能搜到鞋",
    docs: "部署文档有点旧了，按现在的流程更新一下",
    export: "订单列表加一个导出 CSV 的按钮",
    lazyload: "商品详情页的图片太多，首屏加载慢",
    perf: "首页打开有点慢，帮我看看是哪里拖慢的",
  },
  refs: {
    pr42: "改好了，提个 PR 吧",
    issue39: "登录页在手机上按钮错位了，帮我看看是什么原因",
    pr45: "回归测试都过了，提 PR",
    issue38: "优惠码大小写不一致时会用不了，先记个 issue",
    pr31: "可以提交了",
  },
  save: {
    user: "登录页在手机上按钮错位了，帮我看看是什么原因",
    reply: [
      "错位是因为登录表单用了 flex-wrap，改成两列的 CSS Grid 就能对齐。",
      "宽度小于 400px 时，「记住我」和「忘记密码」会被挤到下一行，按钮跟着下移。我在 375px 宽度下复现并确认了这一点。",
      "接下来改 LoginForm 的样式，再补一个窄屏截图测试。",
    ],
  },
  favorites: {
    note: "写 PR 描述时引用这段",
    chat: "优惠券的计算顺序：\n\n1. 先算**满减券**，再算**折扣券**\n2. 一个订单最多用一张满减券\n3. 运费不参与折扣，见 `applyCoupons()`",
    mine: "升级前先确认：v3 的退款接口改了签名，商户后台的回调地址也要同步更新。",
  },
};

const EN: Words = {
  host: { newChat: "New chat", composer: "Reply…", addToChat: "Add to chat", annotate: "Add comment", page: "Second Brain" },
  sidebar: {
    login: "Login bug on phones",
    ipad: "Check iPad landscape",
    coupon: "Coupons at checkout",
    payment: "Payment SDK upgrade",
    search: "Pinyin product search",
    docs: "Update deploy docs",
    export: "Export orders as CSV",
    lazyload: "Lazy-load images",
    perf: "Home page speed",
  },
  titles: {
    login: "Fix the login page layout on narrow screens",
    ipad: "Check the login page in iPad landscape",
    coupon: "Add coupons to cart checkout",
    payment: "Upgrade the payment SDK to v3",
    search: "Pinyin search for products",
    docs: "Update the deployment guide",
    export: "Export the order list as CSV",
    lazyload: "Lazy-load product page images",
  },
  tags: {
    login: ["shop-web", "login-page", "responsive", "PR #42"],
    ipad: ["shop-web", "login-page", "iPad"],
    coupon: ["shop-web", "cart", "coupons", "Issue #38"],
    payment: ["shop-web", "payments", "PR #45"],
    search: ["shop-web", "search", "pinyin"],
    docs: ["docs-site", "deploy"],
    export: ["shop-web", "orders", "CSV"],
    lazyload: ["shop-web", "performance", "PR #31"],
  },
  login: {
    milestones: ["Reproduce it and find the cause", "Open PR #42", "Address the review", "Merge and check production"],
    tasks: ["Reproduce at 375 px wide", "Trace it to the form's flex wrap", "Lay out the form with CSS Grid", "Add narrow-screen snapshot tests", "Widen the button spacing", "Check iPad landscape"],
    doing: "Reply and update the screenshots",
    spinoff: "The sign-up page breaks too",
  },
  ipad: { milestones: ["List the screen widths to check", "Compare screenshots at three widths"], tasks: ["Capture 1024 px landscape"], doing: "Compare 768, 1024 and 1366 px" },
  coupon: { milestones: ["Settle the coupon rules", "Wire up the coupon API", "Show discounts at checkout"], tasks: ["Write applyCoupons", "Warn about expired coupons"], doing: "Warn about expired coupons" },
  payment: { milestones: ["Review what changed in v3", "Switch the order and refund calls", "Open PR #45", "Merge and release"], tasks: ["Update the callback URL", "Run the payment regression tests"] },
  search: { milestones: ["Pick a pinyin tokenizer", "Build the index", "Suggest as you type"], tasks: ["Compare two tokenizers"] },
  docs: { milestones: ["Collect the current steps", "Add how to roll back", "Have ops review it"], tasks: ["List the environment variables", "Write the rollback commands"] },
  export: { milestones: ["Agree on the columns", "Build the CSV on the server", "Download large files in parts"] },
  lazyload: { milestones: ["Find the large images above the fold", "Lazy-load them", "Open PR #31"] },
  prompts: {
    login: "The reviewer wants more space between the buttons; update the screenshots too",
    coupon: "An expired coupon fails the whole order; show a notice instead",
    perf: "The home page feels slow, find out what holds it up",
  },
  firstPrompts: {
    login: "The login buttons are misaligned on phones, can you find out why?",
    ipad: "Check whether the login page has the same problem in iPad landscape",
    coupon: "Checkout needs coupons, both amount-off and percent-off",
    payment: "We have to move the payment SDK to v3; what breaks?",
    search: "Product search should take pinyin: typing xie should find shoes",
    docs: "The deployment guide is out of date, bring it in line with how we deploy now",
    export: "Add an Export CSV button to the order list",
    lazyload: "The product page loads slowly with all those images",
    perf: "The home page feels slow, find out what holds it up",
  },
  refs: {
    pr42: "Looks good, open a PR",
    issue39: "The login buttons are misaligned on phones, can you find out why?",
    pr45: "The regression tests pass, open the PR",
    issue38: "Coupon codes fail when the case differs; file an issue for now",
    pr31: "Ship it",
  },
  save: {
    user: "The login buttons are misaligned on phones, can you find out why?",
    reply: [
      "The cause is flex-wrap; a two-column CSS Grid fixes it.",
      "Below 400 px, “Remember me” and “Forgot password” wrap to a second line and push the button down. I reproduced it at 375 px wide to confirm.",
      "Next I will update the LoginForm styles and add a narrow-screen snapshot test.",
    ],
  },
  favorites: {
    note: "Quote this in the PR description",
    chat: "Coupon order of operations:\n\n1. Apply **amount-off** coupons before **percent-off** ones\n2. At most one amount-off coupon per order\n3. Shipping is never discounted; see `applyCoupons()`",
    mine: "Before upgrading: the refund call changed its signature in v3, and the callback URL has to change in the merchant dashboard too.",
  },
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function demo(locale: Locale, now: number): Demo {
  const w = locale === "zh-CN" ? ZH : EN;
  const ago = (ms: number) => now - ms;
  const task = (id: string, text: string, done: boolean, at: number) => ({ id, text, done, at, ...(done ? { doneAt: at + 10 * MINUTE } : {}) });
  const summary = (at: number, model = "claude-haiku") => ({ at, model });

  const login: Conversation = {
    threadId: IDS.login,
    title: w.titles.login,
    tags: w.tags.login,
    status: "active",
    milestones: [
      {
        id: "lm1",
        title: w.login.milestones[0],
        state: "done",
        doneAt: ago(3 * HOUR),
        tasks: [task("lt1", w.login.tasks[0], true, ago(4 * HOUR)), task("lt2", w.login.tasks[1], true, ago(3 * HOUR + 20 * MINUTE))],
      },
      {
        id: "lm2",
        title: w.login.milestones[1],
        state: "done",
        doneAt: ago(80 * MINUTE),
        tasks: [task("lt3", w.login.tasks[2], true, ago(2 * HOUR)), task("lt4", w.login.tasks[3], true, ago(100 * MINUTE))],
      },
      {
        id: "lm3",
        title: w.login.milestones[2],
        state: "current",
        tasks: [task("lt5", w.login.tasks[4], true, ago(40 * MINUTE)), task("lt6", w.login.doing, false, ago(6 * MINUTE))],
      },
      { id: "lm4", title: w.login.milestones[3], state: "planned", tasks: [] },
    ],
    now: { text: w.login.doing, at: ago(6 * MINUTE) },
    spinoffs: [
      { id: "ls1", text: w.login.spinoff, at: ago(18 * MINUTE), state: "open" },
      { id: "ls2", text: w.login.tasks[5], at: ago(25 * MINUTE), state: "spawned", childThreadId: IDS.ipad },
    ],
    summary: summary(ago(9 * MINUTE)),
    createdAt: ago(4 * HOUR),
    updatedAt: ago(6 * MINUTE),
  };
  const ipad: Conversation = {
    threadId: IDS.ipad,
    title: w.titles.ipad,
    tags: w.tags.ipad,
    status: "active",
    milestones: [
      { id: "im1", title: w.ipad.milestones[0], state: "done", doneAt: ago(15 * MINUTE), tasks: [] },
      { id: "im2", title: w.ipad.milestones[1], state: "current", tasks: [task("it1", w.ipad.tasks[0], true, ago(8 * MINUTE))] },
    ],
    now: { text: w.ipad.doing, at: ago(1 * MINUTE) },
    spinoffs: [],
    parentId: IDS.login,
    summary: summary(ago(4 * MINUTE)),
    createdAt: ago(24 * MINUTE),
    updatedAt: ago(1 * MINUTE),
  };
  const coupon: Conversation = {
    threadId: IDS.coupon,
    title: w.titles.coupon,
    tags: w.tags.coupon,
    status: "active",
    milestones: [
      { id: "cm1", title: w.coupon.milestones[0], state: "done", doneAt: ago(5 * HOUR), tasks: [] },
      { id: "cm2", title: w.coupon.milestones[1], state: "current", tasks: [task("ct1", w.coupon.tasks[0], true, ago(2 * HOUR)), task("ct2", w.coupon.tasks[1], false, ago(12 * MINUTE))] },
      { id: "cm3", title: w.coupon.milestones[2], state: "planned", tasks: [] },
    ],
    now: { text: w.coupon.doing, at: ago(12 * MINUTE) },
    spinoffs: [],
    summary: summary(ago(14 * MINUTE), "gpt-6-luna"),
    createdAt: ago(7 * HOUR),
    updatedAt: ago(12 * MINUTE),
  };
  const payment: Conversation = {
    threadId: IDS.payment,
    title: w.titles.payment,
    tags: w.tags.payment,
    status: "done",
    milestones: [
      { id: "pm1", title: w.payment.milestones[0], state: "done", doneAt: ago(2 * DAY), tasks: [] },
      { id: "pm2", title: w.payment.milestones[1], state: "done", doneAt: ago(DAY + 3 * HOUR), tasks: [task("pt1", w.payment.tasks[0], true, ago(DAY + 5 * HOUR))] },
      { id: "pm3", title: w.payment.milestones[2], state: "done", doneAt: ago(5 * HOUR), tasks: [task("pt2", w.payment.tasks[1], true, ago(6 * HOUR))] },
      { id: "pm4", title: w.payment.milestones[3], state: "done", doneAt: ago(62 * MINUTE), tasks: [] },
    ],
    spinoffs: [],
    summary: summary(ago(70 * MINUTE)),
    createdAt: ago(3 * DAY),
    updatedAt: ago(62 * MINUTE),
  };
  const search: Conversation = {
    threadId: IDS.search,
    title: w.titles.search,
    tags: w.tags.search,
    status: "paused",
    milestones: [
      { id: "sm1", title: w.search.milestones[0], state: "current", tasks: [task("st1", w.search.tasks[0], false, ago(2 * DAY + 2 * HOUR))] },
      { id: "sm2", title: w.search.milestones[1], state: "planned", tasks: [] },
      { id: "sm3", title: w.search.milestones[2], state: "planned", tasks: [] },
    ],
    spinoffs: [],
    summary: summary(ago(2 * DAY + HOUR), "gpt-6-luna"),
    createdAt: ago(2 * DAY + 4 * HOUR),
    updatedAt: ago(2 * DAY + HOUR),
  };
  const docs: Conversation = {
    threadId: IDS.docs,
    title: w.titles.docs,
    tags: w.tags.docs,
    status: "active",
    milestones: [
      { id: "dm1", title: w.docs.milestones[0], state: "done", doneAt: ago(DAY + 5 * HOUR), tasks: [] },
      { id: "dm2", title: w.docs.milestones[1], state: "current", tasks: [task("dt1", w.docs.tasks[0], true, ago(DAY + 4 * HOUR)), task("dt2", w.docs.tasks[1], false, ago(DAY + 2 * HOUR))] },
      { id: "dm3", title: w.docs.milestones[2], state: "planned", tasks: [] },
    ],
    now: { text: w.docs.tasks[1], at: ago(DAY + 2 * HOUR) },
    spinoffs: [],
    summary: summary(ago(DAY + 2 * HOUR)),
    createdAt: ago(DAY + 6 * HOUR),
    updatedAt: ago(DAY + 2 * HOUR),
  };
  const exportCsv: Conversation = {
    threadId: IDS.export,
    title: w.titles.export,
    tags: w.tags.export,
    status: "paused",
    milestones: [
      { id: "em1", title: w.export.milestones[0], state: "done", doneAt: ago(5 * DAY), tasks: [] },
      { id: "em2", title: w.export.milestones[1], state: "current", tasks: [] },
      { id: "em3", title: w.export.milestones[2], state: "planned", tasks: [] },
    ],
    spinoffs: [],
    summary: summary(ago(4 * DAY), "gpt-6-luna"),
    createdAt: ago(6 * DAY),
    updatedAt: ago(4 * DAY),
  };
  const lazyload: Conversation = {
    threadId: IDS.lazyload,
    title: w.titles.lazyload,
    tags: w.tags.lazyload,
    status: "done",
    milestones: w.lazyload.milestones.map((title, index) => ({ id: `zm${index + 1}`, title, state: "done" as const, doneAt: ago(DAY + (3 - index) * HOUR), tasks: [] })),
    spinoffs: [],
    summary: summary(ago(DAY)),
    createdAt: ago(2 * DAY),
    updatedAt: ago(DAY),
  };

  const conversations = { login, ipad, coupon, payment, search, docs, export: exportCsv, lazyload };
  const state: StateV2 = {
    version: 2,
    rev: 42,
    locale,
    conversations: Object.fromEntries(Object.values(conversations).map((conversation) => [conversation.threadId, conversation])),
    prompts: {
      [IDS.login]: { text: w.prompts.login, at: ago(6 * MINUTE) },
      [IDS.coupon]: { text: w.prompts.coupon, at: ago(12 * MINUTE) },
      [IDS.perf]: { text: w.prompts.perf, at: ago(2 * DAY) },
    },
  };

  const status: Record<Key, ThreadInfo["status"]> = {
    login: "running",
    ipad: "running",
    coupon: "waiting",
    payment: "idle",
    search: "idle",
    docs: "idle",
    export: "idle",
    lazyload: "idle",
    perf: "idle",
  };
  const harness: Record<Key, string> = {
    login: "claude-code",
    ipad: "claude-code",
    coupon: "codex",
    payment: "claude-code",
    search: "codex",
    docs: "claude-code",
    export: "codex",
    lazyload: "claude-code",
    perf: "claude-code",
  };
  const keys = Object.keys(IDS) as Key[];
  const info: Record<string, ThreadInfo> = Object.fromEntries(keys.map((key) => [IDS[key], { title: w.sidebar[key], status: status[key], harnessId: harness[key] }]));

  // The PR and issue index: where each one came up, what was asked then, and its news.
  const mention = (key: Key, turn: number, at: number, prompt: string) => ({ threadId: IDS[key], turn, at, role: "user" as const, prompt });
  const ref = (kind: "pr" | "issue", number: number, title: string, state: Ref["state"], mentions: Ref["mentions"], activity?: Ref["activity"]): Ref => ({
    key: refKey(REPO, number),
    repo: REPO,
    number,
    kind,
    url: `https://github.com/${REPO}/${kind === "pr" ? "pull" : "issues"}/${number}`,
    title,
    ...(state ? { state } : {}),
    checkedAt: ago(2 * MINUTE),
    mentions,
    ...(activity ? { activity } : {}),
    lastMentionAt: Math.max(...mentions.map((item) => item.at)),
  });
  const refs: Ref[] = [
    ref("pr", 42, "Fix login layout on narrow screens", "open", [mention("login", 3, ago(80 * MINUTE), w.refs.pr42)], { at: ago(8 * MINUTE), reason: "comment", unseen: true }),
    ref("issue", 39, "Login form breaks below 400px", "open", [mention("login", 1, ago(4 * HOUR), w.refs.issue39)]),
    ref("pr", 45, "Upgrade payment SDK to v3", "merged", [mention("payment", 5, ago(5 * HOUR), w.refs.pr45)], { at: ago(62 * MINUTE), reason: "merged", unseen: true }),
    ref("issue", 38, "Coupon codes are case-sensitive", "open", [mention("coupon", 2, ago(6 * HOUR), w.refs.issue38)]),
    ref("pr", 31, "Lazy-load product images", "merged", [mention("lazyload", 4, ago(DAY + HOUR), w.refs.pr31)]),
  ];
  const workspace: Record<Key, string> = {
    login: "shop-web",
    ipad: "shop-web",
    coupon: "shop-web",
    payment: "shop-web",
    search: "shop-web",
    docs: "docs-site",
    export: "shop-web",
    lazyload: "shop-web",
    perf: "shop-web",
  };
  const scanned = (key: Key, turns: number, at: number): ScanRecord => ({
    turns,
    updatedAt: new Date(at).toISOString(),
    title: w.sidebar[key],
    scannedAt: at,
    cwd: `~/code/${workspace[key]}`,
    firstPrompt: w.firstPrompts[key],
    harnessId: harness[key],
  });
  const index: RefIndex = {
    version: 1,
    rev: 9,
    refs: Object.fromEntries(refs.map((item) => [item.key, item])),
    threads: {
      [IDS.login]: scanned("login", 9, ago(6 * MINUTE)),
      [IDS.ipad]: scanned("ipad", 3, ago(1 * MINUTE)),
      [IDS.coupon]: scanned("coupon", 7, ago(12 * MINUTE)),
      [IDS.payment]: scanned("payment", 6, ago(62 * MINUTE)),
      [IDS.search]: scanned("search", 4, ago(2 * DAY + HOUR)),
      [IDS.docs]: scanned("docs", 3, ago(DAY + 2 * HOUR)),
      [IDS.export]: scanned("export", 5, ago(4 * DAY)),
      [IDS.lazyload]: scanned("lazyload", 5, ago(DAY)),
      [IDS.perf]: scanned("perf", 2, ago(2 * DAY)),
    },
    crawl: { done: true, listed: 128, finishedAt: ago(30 * MINUTE) },
    github: { lastPollAt: ago(2 * MINUTE) },
  };

  const favorites: Favorite[] = [
    { id: "fav1", threadId: IDS.login, text: w.save.reply[0], role: "agent", turn: 2, threadTitle: w.titles.login, note: w.favorites.note, source: "select", createdAt: ago(1 * MINUTE) },
    { id: "fav2", threadId: IDS.coupon, text: w.favorites.chat, role: "agent", turn: 6, threadTitle: w.titles.coupon, source: "chat", createdAt: ago(2 * HOUR) },
    { id: "fav3", threadId: IDS.payment, text: w.favorites.mine, role: "user", turn: 1, threadTitle: w.titles.payment, source: "select", createdAt: ago(DAY + 2 * HOUR) },
  ];

  const row = (key: Key): SidebarRow => ({ threadId: IDS[key], title: w.sidebar[key] });
  return {
    locale,
    now,
    state,
    info,
    parents: { [IDS.ipad]: IDS.login },
    index,
    favorites,
    settings: { ...DEFAULT_SETTINGS },
    sidebar: [
      { workspace: "shop-web", rows: [row("login"), row("ipad"), row("coupon"), row("payment"), row("search"), row("perf"), row("lazyload"), row("export")] },
      { workspace: "docs-site", rows: [row("docs")] },
    ],
    open: { threadId: IDS.coupon, title: w.titles.coupon },
    save: { threadId: IDS.login, title: w.titles.login, user: w.save.user, reply: w.save.reply, passage: w.save.reply[0] },
    host: w.host,
  };
}
