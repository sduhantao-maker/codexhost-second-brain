# 第二大脑（原「主线任务」）v2 设计：一个对话一条主线

- 日期：2026-11-23
- 状态：已实现，0.10.0；0.10 起插件改名为「第二大脑 / Second Brain」（id `second-brain`），每个对话的「主线」和 Agent 运行的 `mainline` 命令不改名。0.8 的修订见 §7、§9、§10 和 §11，0.9 的修正见 §12，0.10 的改名与发布前的修正见 §13。
- 取代：[v1 设计](2026-11-23-mainline-design.md) 第 3、4.1–4.8 节的数据模型和界面；4.9 的 PR 与 Issue 索引保留并推广。

## 1. 为什么改

v1 允许任意窗口加入同一条主线，结果不相关的对话混进了同一条主线；「支线待办」也和用户心中的支线不是一回事。用户的模型是：

- **主线**：这个对话在做什么。一个对话一条主线。
- **里程碑**：做的过程中取得的阶段性进展，有先后顺序。
- **支线任务**：从一个里程碑走到下一个里程碑之间做的具体工作（英文 task）。
- **子对话**：对话里引申出的新问题开子对话处理，借助 codexhost 委派；装了侧栏委派树插件时，出现在侧栏里父对话的下方。

另外，PR 只是一个例子：要能凭任何线索（编号、链接、关键词）找回对话和当时的问题。

## 2. 已确认的决定

| 决定 | 结论 |
| --- | --- |
| 数据模型 | 一个对话一条主线；相关对话靠父子关系（委派树）连接，另可手动「关联到主对话」。 |
| 侧栏 | 鼠标在对话行上停 0.4 秒弹出卡片，显示主线、标签、里程碑节点、正在做、子对话；行上和置顶、归档并排显示里程碑进度。 |
| 引申问题 | 界面和对话里都能开子对话。界面按钮需要再点一次确认，由插件通过 codexhost 委派在本对话下启动。 |
| 旧对话 | 自动生成草稿主线（不持久化、不调用模型）：标题、标签来自对话标题、工作区、索引里的 PR/issue，起因取第一条请求。 |
| 开发方式 | 我写核心与接口约定；侧栏悬停卡片、总览页各交给一个 Claude Code 子对话，在独立 worktree 中开发，最后由我审查合并。 |

## 3. 数据模型（`state.json` version 2）

类型定义以 `src/core/conversation.ts` 为准，这里列要点。

```ts
interface Conversation {           // 键：Thread ID
  threadId: string;
  title: string;                   // 主线标题：做什么 + 对象，具体可识别
  tags: string[];                  // 识别标签，最多 8 个
  status: "active" | "paused" | "done";
  milestones: Milestone[];         // 有序；最多一个 current
  now?: Stamp;                     // 正在做（属于 current 里程碑）
  spinoffs: Spinoff[];             // 引申问题
  relatedTo?: string;              // 手动关联的主对话（同一件事，非委派）
  parentId?: string;               // 委派父对话（来自 codexhost，后台维护）
  pinned?: { title?; tags?; status? }; // 用户在界面上改过的部分，模型凝练不改（§9）
  removedMilestones?: string[];    // 用户删掉的里程碑标题（最多 20 个），模型凝练不再加回
  summary?: SummaryRecord;         // 最近一次模型凝练：时间、模型、读的是对话哪个版本、几轮、是否已完成
  createdAt: number;
  updatedAt: number;
}
interface Milestone { id; title; state: "done" | "current" | "planned"; doneAt?; tasks: Task[]; pinned? /* 用户加的或改过名的 */ }
interface Task { id; text; done: boolean; at; doneAt?; threadId? /* 由子对话完成 */ }
interface Spinoff { id; text; at; state: "open" | "spawned" | "dismissed"; childThreadId? }
interface State {
  version: 2; rev; locale?;
  conversations: Record<string, Conversation>;
  prompts: Record<string, Stamp>;
  excluded?: Record<string, number>;          // 用户删掉主线的对话和时间（最多 2000 个，§9）
  jobs?: { backfill?: { requestedAt: number } }; // 整理旧对话的请求，重启后继续（§9）
}
```

- 规则：添加任务或设置「正在做」时没有 current 里程碑，就先把第一个计划中的里程碑设为当前；没有时新建「第 N 阶段」（英文 Stage N）作为 current。达成 current 里程碑时，下一个 planned 自动变为 current。
- `prompts`：hook 记录的每个窗口最近一条消息（不论有无主线），14 天未更新的清除。
- 上限：主线最多 `MAX_CONVERSATIONS`（2000）条，一条主线最多 30 个里程碑、每个里程碑 60 个任务（`V2_LIMITS`）；超出时怎么让位见 §12。
- **迁移 v1**：每条 v1 主线只转给「主窗口」（`via: "agent"` 的成员，否则最早加入的成员）。目标 → 标题；已完成 → 已达成的里程碑；正在做 → `now`；支线待办 → 未处理的引申问题；已结束 → `status: "done"`。其他成员不再挂在这条主线上（委派关系仍由委派树表示）。

## 4. 关系、草稿与查找

- **父子关系**：来自 Desktop 上报的委派树、Web 侧栏行的 `data-thread-parent`、按需调用 `/v1/thread/list { parentThreadId }`，以及子对话由插件开出时的记录。后台汇总后写入 `Conversation.parentId`，并在视图里给出子对话列表。
- **草稿主线**：没有记录的对话，由后台按需生成视图，带 `draft: true`：标题取 codexhost 标题，标签取工作区目录名、索引中 PR/issue 所在仓库与编号（最多 3 个），起因取扫描到的第一条请求。不写入 `state.json`。
- **查找**（`search` / `mainline find`）：用线索找对话，匹配主线标题、标签、里程碑、支线任务、引申问题、PR 与 Issue（编号和链接）、codexhost 标题、第一条请求和当时的问题。排序：PR 与 Issue 精确匹配 > 标签 > 标题 > 里程碑/支线任务 > 其他；同分按最近活动。最多 20 条。「线索」一词只用于查找（0.10 起，见 §13）。
- **PR 与 Issue 索引**：沿用 v1 的 `refs.json`，扫描时额外记录每个对话第一条请求（`ScanRecord.firstPrompt`）。

## 5. 接口约定（`src/core/rpc.ts`）

| 方法 | 用途 |
| --- | --- |
| `snapshot` | 同 v1，`state` 为 version 2，另带 `parents`（已知的子 → 父）；0.10 起从旧版复制过数据、旧目录还在时另带 `migration.oldFolder`（§13）。 |
| `conversation { threadId }` | 一个对话的完整视图 `ConversationView`：主线或草稿、里程碑、子对话、父对话、PR 与 Issue。悬停卡片和对话内卡片使用。 |
| `search { query }` | 查找结果 `SearchResult[]`。 |
| `mutate { op, … }` | v2 编辑操作，见 `MutateV2Params`。 |
| `spawn { threadId, spinoffId }` 或 `{ threadId, text, attachments? }` | 为引申问题或新写的一句问题在本对话下开子对话（可附带上传好的文件），返回子对话 ID。 |
| `attach.begin`、`attach.chunk` | 悬停卡片分块上传开子对话时附带的文件。 |
| `attachments.usage`、`attachments.clear` | 总览页「设置」里附件的占用和清理。 |
| `summarize { threadId }`、`summarize.backfill`、`summarize.cancel` | 立即凝练一个对话；开始、停止整理旧对话（§9）。 |
| `favorites.add`、`favorites.list { query, offset, limit }`、`favorites.get { id }`、`favorites.note`、`favorites.remove`、`favorites.reveal`、`favorites.revealed` | 收藏（§10）。`favorites.list` 分页（默认 100 条、最多 300 条），每条只给前 600 字（`truncated`），另给 `matched` 和 `nextOffset`；`favorites.get` 给一条的全文（§12）。 |
| `reportTree` | Desktop 委派树；Web 也用它上报侧栏行上的父子关系。 |
| `refs.list`、`refs.seen`、`refs.seenForThread`、`integration.*`、`diagnose` | 同 v1；`refs.seenForThread { threadId }`（0.10.3）把来源是这个对话的新动态都标为已看，见 §14。`refs.list` 从最新的开始放到答复上限，放不下的个数在 `omitted`。`integration.status` 和 `integration.preview` 在不可用时另给 `problem`（`NOT_SET_UP`、`NOT_A_FOLDER`、`FOLDER_UNREADABLE`、`FILE_UNREADABLE`、`NOT_JSON`、`NOT_AN_OBJECT`）和 `cause`（系统错误码），总览页按它用页面的语言说明。`refs.forThread`、`refs.search`、`refs.status` 还在，但现在没有界面调用。 |

- **快照的大小**：完整状态超过 1 MiB 时，一部分对话只发提纲，`outline` 给出它们已达成和总共的里程碑数；连提纲都放不下时省掉最旧的条目，`omitted` 给出个数。读快照里的状态一律经过 `normalizeStateV2`（提纲没有标签、引申问题和任务）。
- **凝练状态**（`SummarizerStatus`）：`backfill.full` 是因主线已满而不发送的没有主线的对话数；`lastErrorCode` 是最近一次失败的错误码，或 `CLAUDE_MISSING`、`CODEX_MISSING`、`MODEL_CALLS_OFF`。
- **错误**：以「[CODE] 英文消息」返回，代码表是 `src/core/model.ts` 的 `ERROR_CODES`（§12）。

视图函数：`conversationView(...)` 在 `src/core/conversation-view.ts`，`progressOf(...)` 在 `src/core/conversation.ts`。界面不自行拼装数据。

## 6. 界面

- **侧栏悬停卡片（子对话 A）**：在侧栏行上停 0.4 秒后，在侧栏右侧、与行对齐处显示卡片。卡片已打开时移到另一行立即切换，离开侧栏后隐藏。内容为标题、标签、里程碑节点（✓ 已达成 · ● 当前 · ○ 计划，当前节点下列出支线任务和正在做）、子对话、父对话、主要的 PR 与 Issue；没有主线的标「未凝练」（悬停说明含义）。行上和置顶、归档并排显示「◆ 已达成/总数」。覆盖 Desktop 原生行、侧栏委派树画出的子行（`data-codexhost-sidebar-tree-node`）和 Web 行（`data-row-key`）。行上的进度只在悬停时显示。codexhost Web 悬停时自己会在侧栏边上弹出会话预览（`body` 下的固定定位元素），卡片放到它右边，指针穿过预览时卡片不隐藏。
- **对话内胶囊与卡片（我）**：0.3.1 起可选，默认关闭（设置「对话标题栏也显示主线胶囊」）。胶囊显示主线标题 · 当前里程碑 · 正在做；卡片显示里程碑时间线、支线任务、引申问题（「开子对话」「本对话处理」「忽略」）、子对话、PR 与 Issue 和查找。不能撤销的删除连点两次，能撤销的操作点一次（§13）。
- **总览页（子对话 B）**：页面标题「第二大脑 / Second Brain」（0.10 以前叫「主线总览」）。顶部是全局查找，下面四个页签：对话（进行中/暂停/已完成/没有主线，按时间或项目分组，子对话折叠在父对话下）、收藏、PR 与 Issue、设置（从旧版复制过数据时的说明；Agent 协作；设置，含模型凝练的次数和整理旧对话；附件）。

## 7. 给 Agent 的约定（hook 与 `mainline show`，0.8 修订）

- **全文与状态行**：Claude Code 的 hook 在每个 Claude 会话的第一条消息时给全文：主线、标签、里程碑、当前里程碑的任务、正在做、引申问题、子对话、父对话和约定。之后在第 30 条消息后、超过 12 小时或约定变化时再给全文。约定的指纹包含插件版本和约定文本，所以偏题设置、模型凝练开关、语言、是不是子对话变了都算；关掉模型凝练时，有没有主线也算。其间只在状态行变了时给一行，例如 `【主线】「标题」（已暂停） · 里程碑 2/4，当前「…」 · 正在做：… · 1 个引申问题未处理`；没变就什么都不加。hook 收不到会话编号时每次都给全文。
- **Codex**：AGENTS.md 里只有一句：对话第一条消息时运行一次 `mainline show` 并照做。`show` 同样第一次打印全文，之后打印状态行和「完整内容（里程碑、支线任务和约定）：mainline show --full」；第 30 次、超过 12 小时或约定变化时再打印全文。`--full` 和 `--json` 不改记录。
- **记录**：给过什么记在数据目录的 `context/<对话>.<hook|show>.json`，只有指纹、时间、Claude 会话编号和计数，不存原文。打印全文时顺手删掉 3 天没用的记录。记录坏了或丢了，只是下一次再给全文。
- **谁的对话**：对话 id 依次取 `--thread`、`CODEXHOST_THREAD_ID`、`CODEX_THREAD_ID`。只有 `CODEX_THREAD_ID` 时（Codex 在每个会话里都设它），要环境里有其他 `CODEXHOST_*` 变量（codexhost 启动的会话都有，例如它的命令路径和运行时地址），或 codexhost 认识这个对话（有主线、记过消息、在 PR 索引里），才算 codexhost 的；否则 hook 和 `show` 什么都不输出，退出码 0。
- **约定的内容（开着模型凝练，默认）**：标题、标签、里程碑和状态由模型凝练，Agent 不用维护；支线任务开始时 `mainline doing "…"`，完成时 `mainline done`；偏题规则按设置（「先问我」：先别动手，`mainline spinoff "一句话"` 并建议开子对话，用户同意时 `mainline spawn <编号>`，在本对话做 `mainline keep <编号>`，不管 `mainline dismiss <编号>`；「只记录」：照常处理，同时 `spinoff`，回复开头说明不在主线上）；子对话专注自己的任务，完成后一两句话总结；提交 GitHub PR 或 issue 后 `mainline link <链接> "用途"`（只收 GitHub 的 PR 和 issue 链接），不清楚来历的编号 `mainline find <线索>`；收藏 `mainline fav last` 或 `mainline fav "<原文>"`。全部命令见 `mainline --help`。
- **关掉模型凝练时**：没有主线的对话还会看到草稿和第一条请求，约定是「多步任务运行 `mainline new "具体标题" --tags "a,b,c" --plan "阶段1|阶段2|阶段3"`，闲聊不建」；有主线时加上标题、标签、`plan` 和 `reach` 的规则。
- **没有主线时记录工作**：`doing`、`task`、`done "…"`、`spinoff` 以草稿为起点建立主线：标题取 codexhost 的对话标题，没有就取第一条请求，再没有就取最近一条消息或这条任务（`spinoff` 取对话短编号），标签取草稿的。用户删掉过主线的对话例外：这些命令报错，说明主线是用户删的，不要重建；Agent 明确运行 `mainline new` 仍会建立，并取消删除标记。
- **报错**：开着模型凝练时，「没有主线」的报错不再让 Agent 手写主线，而是让它先用 `doing`、`task`、`done` 记录；`reach` 在没有当前里程碑时就说这个，不说「没有主线」。

## 8. 分工与合并

| 工作 | 负责 | 文件范围 |
| --- | --- | --- |
| 核心、后台、命令行、约定、胶囊、迁移、开子对话 | 本对话 | 除下两行外的全部文件 |
| 侧栏悬停卡片 | 子对话 A（Claude Code） | `src/ui/hover/**`、`test/hover.test.ts`；`src/desktop/*`、`src/web/*` 中标记为 hover 的接入点 |
| 总览页 | 子对话 B（Claude Code） | `src/page/**`、`test/page.test.ts` |

- 子对话不改自己范围以外的文件；需要改接口时写在交付说明里，由本对话统一修改。
- 各自的文案放在自己目录下（`src/ui/hover/strings.ts`、`src/page/strings.ts`），不改 `src/ui/i18n.ts`。
- 交付标准：`npm ci && npm run check` 通过，提交到各自分支，交付说明列出做了什么、怎么验证的、还有什么没做。

## 9. 模型凝练（0.4，用户已确认；0.8 修订）

用户的四个决定：跟随对话选模型；每轮回复结束后自动凝练；手动改过的固定不动；旧对话现在全部凝练一遍。

- **分工**：模型写标题、标签、里程碑和状态；对话里的 Agent 只记具体任务、引申问题和链接（钩子里的约定随之变短）；用户在界面上改的标题、标签、状态和里程碑会被固定（`pinned`、`Milestone.pinned`、`removedMilestones`），总览页可以「恢复自动凝练」。
- **选哪个模型**：`summarizeModel`（跟随对话 / 都用 Claude Haiku / 都用 Codex）只管 Claude Code 和 Codex 的对话；跟随时 Claude Code 的对话用 Claude Haiku，Codex 的对话用 Codex。其他 Agent 的对话（codexhost 的 `harnessId` 不是 `claude-code` 或 `codex`，或没有写）按 `summarizeOthers`，默认 `none`：不发给任何模型，保持「未凝练」；手动凝练报 `NO_SUMMARIZER`，总览页和悬停卡片说明是哪项设置。对话的 Agent 先看 `/v1/thread/list` 列出的 `harnessId` 和 PR 索引里记下的，读到对话时再更新，所以其他 Agent 的对话不用逐个去读。
- **调用**：Claude 用 `claude -p --model haiku --tools "" --setting-sources local --strict-mcp-config --no-session-persistence`，`claude --help` 有 `--effort` 时加 `--effort low`。Codex 用 `codex exec --model gpt-6-luna --ephemeral --ignore-user-config --sandbox read-only --json`，用 `-c features.<名字>=false` 关掉 shell_tool、unified_exec、shell_snapshot、view_image、apps、plugins、remote_plugin、browser_use、in_app_browser、computer_use、memories、hooks、image_generation、multi_agent（Codex 不认识的名字会被忽略，`--disable` 遇到不认识的名字会直接退出），再加 `web_search="disabled"` 和低推理强度；`codex exec --help` 有 `--ignore-rules` 时加上。只有 Codex 提示小模型对这个账号不可用时，才换默认模型重试一次，同样低推理强度；超时和其他失败不重试。找不到 `claude` 或 `codex` 时直接报错，不改用另一家，这次也不计数。调用在空的私有目录里进行，不带 codexhost 的会话变量；Claude 的登录信息取自 `~/.claude/settings.json` 的 `env`。错误信息只说出了什么问题，不带模型写的内容，并遮掉密钥。
- **输入与输出**：最近 40 轮（每轮用户话 600 字、助手回复 400 字以内，总共约 24k 字），加上已有主线和对话开头的请求；按 JSON Schema 返回 `title`、`tags`、`milestones[{title,state}]`、`finished`。发送前用 `maskSecrets`（`src/core/redact.ts`）遮掉常见形式的密钥：`sk-`、`ghp_`/`github_pat_`、`AKIA`、`xox?-`、JWT、私钥块、`Bearer`、链接里的密码，以及 `password=`、`token:` 一类的赋值；用户消息去掉前面的附件清单。
- **成本**：一次 Codex 凝练会带上 Codex 自己约 16–17k 个输入 token 的说明，与对话长短无关；在意这部分开销就在设置里选 Claude Haiku。
- **合并规则**（`applySummary`）：已达成的里程碑是历史，原样按顺序保留；模型给出的其余里程碑接在后面，按「已达成 → 当前 → 计划」排；被模型去掉的里程碑上的任务转到当前（未完成）或最后一个已达成的里程碑（已完成）；状态按 `finished` 和静默时长（7 天）设定，Agent 正在做任务时不改。
- **触发与限额**：每分钟看一次最近 30 个对话，静默满 1 分钟、24 小时内有更新、且比上次凝练有变化才跑，同一对话至少隔 10 分钟；每天自动最多 200 次。凝练失败的对话 30 分钟后重试，之后每次加倍，最长 8 小时；对话有新一轮或用户要求时立即重试（0.9 起，见 §12）。关掉自动凝练后，排队的自动任务直接丢掉，轮到时也再看一次设置；手动凝练和用户开始的整理照常运行。悬停卡片和总览页可以手动「重新凝练」。
- **计数与日志**：每次调用前按本地日期、模型和原因（自动、手动、整理旧对话）记进 `summary-counts.json`（独立的锁，保留 14 天），每天 200 次的上限从这里算，重启不清零。设置页显示「今天自动凝练 N/200（Claude a，Codex b）」和手动、整理旧对话的次数。每次调用在 `backend.log` 写一行：模型、原因、对话短 id、耗时、成败，不含对话内容。
- **整理旧对话**：总览页「设置」里的按钮写着「整理旧对话：最多把 N 个对话发给模型」，3 秒内连点两次才开始；N 不含按设置不发送的其他 Agent 的对话。`mainline summarize --all` 也能开始（不经过连点两次），回复里说明其他 Agent 的对话不发送；已在进行的整理保留原来的开始时间。请求存在 `state.jobs.backfill`，重启后继续。0.9 起每次整理每个对话最多发送一次（`backfill-tried.json`），也不让主线超过 2000 条（§12）。「停止」（`summarize.cancel`）去掉请求、丢掉排队的任务，正在进行的那次做完并保留结果。日志记下从总览页或命令行开始、重启后继续、停止和结束。
- **删掉的主线**：用户删除主线时，记下这个对话（`state.excluded`，最多 2000 个），并删掉它存的最后一条请求；自动凝练和整理旧对话都跳过它，模型正在写时被删也不会写回。用户点「立即凝练」「建立主线」，或 Agent 运行 `mainline new` 时取消标记；Agent 的 `doing`、`task`、`done`、`spinoff` 不会把它建回来（见 §7）。

## 10. 收藏夹（0.6，用户已确认）

用户的需求：模型的某段回复很重要，不截图、不复制到别处的话，过后想起来就找不到在哪个对话的哪个位置。用户选的方式：选中文字弹出「★ 收藏」，另外在聊天里说「收藏上一条回复」由 Agent 存整条。

- **存储**：`favorites.json`（version 1，独立的锁，最多 5000 条、16 MB，0.8 起紧凑写入）。每条记原文（20k 字以内）、来源对话、当时的对话标题、第几轮和谁说的（找得到时）、备注、来源（选中 / 聊天）和时间。同一对话里同一段话（忽略空白）只存一次。
- **选中收藏**：Desktop 和 Web 的对话区里，选中消息中的文字（不含输入框、只有一个字的选区不算）后弹出「★ 收藏」。codexhost Web 自己有「添加到对话 | 添加批注」浮条时，按钮接在它右边，样式一致；没有时放在选区上方。点按钮不清掉选区。保存后先回答，再到后台用 codexhost 的消息视图找这段话在第几轮（先看最近 10 轮，再往前看 60 轮）。按钮位置和跳回原文的诊断上报，0.8 起只在这个界面开了诊断（`localStorage["codexhost-mainline:debug"] = "1"`）时进行。
- **聊天收藏**：`mainline fav last` 存上一条回复的全文（Agent 运行时本轮还在进行，所以取最近一个已结束轮次的最终回复，去掉 `:codex-annotation{…}` 标记）；`mainline fav "<原文>"` 存指定段落；`fav list`、`fav remove` 查看和删除。规则在约定全文里：Claude Code 在会话的第一条消息等时候收到（见 §7），Codex 第一次运行 `mainline show` 时读到，不用改 AGENTS.md。
- **匹配**：屏幕上选中的是渲染后的文字，接口给的是 Markdown 原文。两边都只比较字母和数字（`skeleton`：去掉强调、列表编号、链接地址和代码围栏），并用各行最长的片段找位置，所以列表、表格和代码块不影响匹配。
- **总览页**：「收藏 N」页签，按时间倒序；可搜原文、备注和对话标题；长段落折叠；可复制、写备注、删除（连点两次确认）。Agent 存的整条回复是 Markdown 原文，按排版显示（段落、列表、代码、表格，只开 http/https 链接）。全局搜索也会因收藏的原文命中对话。
- **跳回原文**：总览页点「跳回原文」→ 后台记下待显示的段落（2 分钟内有效）→ 打开对话 → 该对话所在的界面在下一次快照里拿到它，在消息里找到这段文字，滚到中间，用 CSS Custom Highlight API 高亮（不支持时改为选中）。没在已加载的轮次里找到时，滚到顶部让宿主加载更早的轮次，最多找 16 秒，找不到就提示一句。
- **Desktop 上的跳转（0.6.1）**：Desktop 的总览页在 codexhost 的设置浮层里。打开对话后要关掉浮层（`window.__codexhostSettingsShellV1.close()`，只在它开着时），对话才会露出来；打不开时（比如另一台机器上的对话）浮层不关，总览页说明原因。浮层挡着时对话没有排版，所以找到段落后要等它真正显示出来，再滚动和高亮。总览页上所有「跳转」都走这条路。

## 11. 审查后的修正（0.8）

对 0.7.1 审查后，分三块修正。细节写在 §7、§9、§10 和 v1 设计里标「0.8 起」的注记。

- **给 Agent 的上下文变轻**（§7）：hook 不再每条消息都附全文，其间只给变化的状态行；Codex 只在对话第一条消息运行一次 `show`，AGENTS.md 的段落缩成一句；没有主线时记录工作直接从草稿建主线，用户删掉的主线除外；Codex 会话靠其他 `CODEXHOST_*` 变量认出是 codexhost 启动的。
- **模型调用收紧**（§9）：其他 Agent 的对话默认不发给模型，悬停卡片说明原因；找不到命令时报错，不换服务商；Codex 不带工具，加 `--ignore-rules`；整理旧对话连点两次、写明数量、可以停止；删掉的主线不会被写回；调用次数存在磁盘上；发送和保存前遮掉密钥，旧版本存的最后一条请求和 PR 索引里的请求、对话开头在启动时补遮一次，只在有改动时写入，日志只记个数。
- **后台负载和数据**：对话标题和状态由一次共用的对话列表回答，单独读有退避；快照版本只随页面看得到的内容和全部设置变；PR 索引攒着写，只存工作目录的最后一级和 Agent，忘掉 codexhost 已经没有的对话；GitHub 轮询时间另存在 `github-poll.json`，看 PR 时查到的内容没变就不每分钟重写 `refs.json`；总览页隐藏时不轮询，PR 状态只在「PR 与 Issue」页签显示时查；诊断默认关闭；数据文件紧凑写入；附件在后台也限每个子对话 1 GiB，开子对话失败时 codexhost 拒绝或连不上就删、没等到回答就留下不记归属；Agent 协作的备份只有用户能读，每个文件最多 3 份，超过 30 天的在下次备份时删掉，读不了的配置文件不再当成不存在。

已知限制（0.10 的现状）：

- 后台接口分不出请求来自本机还是远程的 codexhost Web 会话：拿到 codexhost Web 会话的人，能做总览页和悬停卡片能做的一切。
- hook 也会在继承了 codexhost 对话环境的嵌套 Claude 运行里执行，把那里的消息记成这个对话的最近一条消息。
- Claude Code 压缩上下文后，全文要等第 30 条消息后的刷新、新会话或 12 小时后才再给。
- 超过 30 天的备份只在下次安装或卸载 Agent 协作时删掉，没有定时清理。
- 插件请 codexhost 开子对话（`/v1/delegate/start`）最多等 20 秒的答复；这之后才开出来的子对话不会挂到引申问题上，再点一次可能开出第二个。codexhost 不告诉迟到的结果，插件这边补不上。
- 只在 macOS 上测试过，Windows 和 Linux 没有验证。
- 悬停卡片只能用鼠标打开：键盘打不开，触屏也打不开（触屏没有悬停）。主线胶囊默认关闭，所以只用键盘或在手机上时，对话里看不到主线；胶囊和总览页能用键盘操作。给悬停卡片加键盘操作这次不做（0.10 的决定，§13）。
- `MAINLINE_NO_MODEL=1` 只对测试和开发运行有效：codexhost 启动后台时几乎不带环境变量，装好的后台收不到它。
- 总览页「PR 与 Issue」页签的本地筛选只看得到一条答复（1.5 MiB）放得下的那些 PR 和 issue；全局查找不受影响。
- 复制一条被截短的收藏要先取全文再写剪贴板；要求「新鲜的用户操作」的浏览器可能因此复制失败，这时页面会说复制没有成功。

## 12. 工程审查后的修正（0.9）

对 0.8.0 做了三份工程审查（正确性、发布、质量），分三条分支修正（存储、后台边界、文案与无障碍），合并时把跨分支的部分接上。

- **锁**：锁目录里记着持有者（进程号加随机令牌），持有期间每 0.5 秒刷新；残留的锁要 10 秒没刷新、又 1.5 秒没有变化才接管，接管和释放经过短暂的 `<锁>.guard` 一次一个，接管前再确认还是同一把，释放只删自己的锁，写入前再确认锁还是自己的（见 v1 设计 4.1）。hook 的 400 毫秒等不到接管，命令行和后台的 2 秒可以。
- **损坏和更新版本的数据文件**：`state.json`、`favorites.json`、`refs.json`、`summary-counts.json`、`attachments/owners.json` 和上下文记录读不出来时，在被覆盖前另存为 `<名字>.corrupt-<时间>.json`，每个文件最多留 3 份；计数文件另存时后台写一行日志（当天的自动凝练次数从 0 重新算）。版本比当前代码新的文件不改名、不覆盖，读写都报 `NEWER_VERSION`；上下文记录例外，读作「没给过」（于是再给全文），写入照样报错。其他读取错误（如没有权限）直接报出，不当成空文件。
- **主线和里程碑的上限**：主线最多 `MAX_CONVERSATIONS`（2000）条。用户手改过的（标题、标签、状态，或加过、改过、删过里程碑）、还有未完成任务或正在做的主线不会被挤掉；其余先挤掉已完成的、再挤掉最旧的。这次改动新建的记录不会被挤掉：没有别的能挤，或新建的这条自己会最先被挤掉时，整次改动被拒（`STATE_FULL`），不新建的改动不报错。开出来的子对话没有位置时只记下链接（`hasRoomForMainline`）。里程碑满 30 个、又要开新阶段时，最早达成的一个（先挑不是用户加或改过的）让位，它没完成的任务跟到新阶段；删除里程碑后任务也守 60 条上限；v1 迁移最多 30 个里程碑和 30 个引申问题。写入的都能原样读回。
- **整理旧对话和凝练**：每次整理每个对话最多发送一次：发送前记在 `backfill-tried.json`，重启后照样不重发，失败的算作失败、不再重试，整理结束或停止时删掉这个文件。主线已有 2000 条时整理不给没有主线的对话新建，它们不发送，计入 `backfill.full`（总览页写明个数）；「最多 N 个」只算真正会发送的；发送前再看一次。`recordCap()` 取自 `MAX_CONVERSATIONS`。没有主线的对话在主线已满、又没有能让位的主线时（`hasRoomForMainline` 为假），自动凝练不读也不发（每天在日志里记一次），手动凝练立即报 `STATE_FULL`；写入时仍因此被拒的，8 小时后才再试，新一轮也不提前。其他失败 30 分钟后重试，之后每次加倍，最长 8 小时，对话有新一轮或用户要求时立即重试；发出过的失败调用照旧计入当天。
- **开子对话**：`spawn`、`summarize` 和 `summarize.backfill` 最多等 8 秒（`HANDLER_BUDGET_MS`，codexhost 给每次调用 10 秒），没做完的在后台继续。`spawn` 等不到 codexhost 时答复 `PENDING`：悬停卡片和总览页显示「正在打开子对话」的提示而不是失败，卡片留着输入的问题和附件，等快照里出现链接再说已开好并清掉；同一问题再点一次并入正在进行的那次，开好后再写同样的问题直接给出那个子对话。用户删掉主线的对话上开子对话，开成之前什么都不写；开成后用 `createConversation(…, { keepExcluded: true })` 建一条记录挂上链接，删除标记保留，模型凝练照旧跳过。命令行 `spawn` 对已开过子对话的引申问题给出那个子对话。子对话的第一条消息先写问题本身，再用一行写父对话的标题和当前里程碑，标明「背景（由模型概括，仅供参考）」。后台停止时立即中断对 codexhost 和 gh 的请求，最多再等 0.7 秒写完。
- **答复大小**：后台的每条答复不超过 1.5 MiB（`REPLY_LIMIT_BYTES`，codexhost 的上限是 2 MiB），超过一律 `TOO_LARGE`。快照的目标是 1 MiB：放不下时先把最近请求截到 60 字，再把最不需要的对话（已完成、最旧的优先）发成提纲，仍放不下时省掉最旧的条目；总览页展开提纲里的对话时用 `conversation` 取全。收藏分页列出、给摘录，展开全文和复制时用 `favorites.get` 取全文；`refs.list`、`refs.forThread` 从最新的开始放到上限；查找结果每条最多 20 个 PR、300 字匹配文字；单个对话视图过大时先去掉已达成里程碑的任务。
- **卸载后**：装在数据目录里的 `mainline` 按 codexhost 的布局判断：`<根目录>/host-extensions/<插件 id>` 不在，或 `enabled.json` 不含这个 id 时（0.10 起 id 是 `second-brain`），`hook` 和 `show` 不输出、不写入；读不了或看不懂的一律当作仍启用，其他命令照常。
- **错误码**：错误以「[CODE] 英文消息」到达界面，代码表是 `ERROR_CODES`：`INVALID_ARGUMENT`、`EMPTY_TEXT`、`NO_THREAD`、`NO_MAINLINE`、`NO_CURRENT_MILESTONE`、`UNKNOWN_ITEM`、`MILESTONE_EXISTS`、`MILESTONE_LIMIT`、`LOCKED`、`STATE_FULL`、`FAVORITES_FULL`、`FILE_FULL`、`TOO_LARGE`、`ATTACHMENT_TOO_LARGE`、`TOO_MANY_ATTACHMENTS`、`UPLOADS_BUSY`、`CHILD_FILES_TOO_LARGE`、`NO_SUMMARIZER`、`UNAVAILABLE`、`NEWER_VERSION`、`PENDING`。总览页、胶囊、悬停卡片（用胶囊的说法）、★ 按钮和命令行按码说中英文（各自的表以 `Record<ErrorCode, …>` 写成，少一个码编译不过），不认识的码照原文显示；不再按英文消息分辨原因。Agent 协作不可用的原因和凝练时找不到工具也带码（§5），总览页用页面的语言说明。
- **对话 id**：`isThreadId` 只收 codexhost 存储允许的字符（`^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$`），不收 `constructor` 这类对象自带的名字。后台每个带对话 id 的调用（`conversation`、`spawn`、`summarize`、`refs.forThread`、`favorites.add`、`mutate`）先检查，不合格报 `INVALID_ARGUMENT`；快照的 focus 和委派树里不合格的直接忽略；命令行的 `--thread` 不合格就报错，环境变量里不合格的当作没有对话。按 id 查记录一律只看自有属性。
- **遮密钥**：请求先截到 8000 字（截在空白处，跨在截断处的密钥整个遮掉）再遮；各条规则一次扫描的长度有界（协议名 32 字、密钥名在关键词前 64 字、`sk-` 密钥 128 字内有数字、JWT 头 512 字），耗时随长度线性增长。代价：超过这些长度的写法不再遮。
- **其他修正**：安装或卸载 Agent 协作时改写软链接指向的文件，链接保持不变；收藏里的引用最多嵌套 8 层，表格拆分不用后行断言（Safari 16.4 以前解析不了）；日志的启动行记插件版本、Node 版本和平台，每行的主目录写作 `~`、路径里的用户名写作 `<user>`；`NotSentError` 分成 `ApiNotReachedError` 和 `ModelNotSentError`，本机接口的客户端移到 `src/node/external-api.ts`；大小写作 500 MB、1 GB；`dist/mainline.zip` 带上 LICENSE。
- **文案与无障碍**：文案按代码改正（模型也设状态、未凝练的各种情况、子对话只在装了委派树插件时缩进、PR 提醒只在有人评审合并或评论时等）；英文界面不出现中文标点。总览页每行的标题是独立按钮，页签可用方向键，编辑和操作后焦点回到原处或下一个控件；两次确认读给读屏（悬停卡片的状态行放在卡片外常驻，重建卡片不打断播报）；文字对比度在浅色和深色下都到 4.5:1；减少动画时不平滑滚动。
- **测试**：`MAINLINE_NO_MODEL=1`（vitest 全程设置）让模型调用在找工具、启动进程之前就被拒绝，也不计数；模型调用本身的测试用替身工具并关掉这个开关。端到端测试先从当前源码构建。按 CPU、子进程或等待计时的测试写明时限。

## 13. 改名与发布前的修正（0.10）

用户为首次公开发布做的决定，0.10.0 实现：

- **名字**：插件改名为「第二大脑 / Second Brain」，id `second-brain`，仓库名 `codexhost-second-brain`。一句话介绍：「记住每个对话在做什么、做到哪一步、哪段回复值得留下」/ "Remembers what each conversation is doing, how far it got, and which replies are worth keeping"。总览页标题改为「第二大脑」。每个对话的「主线 / mainline」、Agent 运行的 `mainline` 命令不改名；用户看不到的内部标识也保留 mainline：DOM 属性（`data-codexhost-mainline…`）、自定义事件名、localStorage 的键（诊断开关 `codexhost-mainline:debug` 和胶囊位置）、Codex AGENTS.md 段落的标记（`<!-- codexhost-mainline:start -->`），段落的标题和署名改为 Second Brain。
- **从旧版复制数据**（`src/backend/migrate-from-mainline.ts`）：codexhost 给新 id 一个新的空数据目录。后台启动时、在读写任何数据之前，若新目录还没有数据（数据文件、`context/` 的记录、附件都没有）而同级的 `mainline/` 有，就在新目录的状态锁里把 `state.json`、`refs.json`、`favorites.json`、`summary-counts.json`、`github-poll.json`、`backfill-tried.json`、`context/` 的记录和 `attachments/`（上传编号命名的文件夹和 `owners.json`）复制到暂存目录 `.migrating-from-mainline/`，最后写计划 `ready.json`；再逐项移到位（已有的不覆盖），最后写 `migrated-from-mainline.json`（时间、复制的文件名和个数、设置的处理结果）。没有计划的暂存目录是中途停下的半份副本，下次丢掉重做；有计划的下次接着移完；有标记就不再复制。不复制 `backups/`、`state.v1.json`、损坏另存的副本、日志、`bin/`、`model-runs/`、锁和临时文件；旧目录只读，不移动、不修改、不删除（子对话仍从那里读附件）。附件能克隆就克隆（`COPYFILE_FICLONE`），不能克隆时合计不超过 64 MB 才普通复制，否则全部留在旧目录，读不了的也留下，标记里记着个数：codexhost 只给后台 5 秒启动，超时的启动会被结束、下次又从头复制，所以复制必须在慢的磁盘上也只要一秒以内。数据文件读不了时整次复制失败、不留半份，下次启动再试。
- **设置**：codexhost 按 id 保存设置（数据目录里的 `settings.json`，`{ settingsRevision, values }`）。新 id 的设置还没改过（没有 `settings.json` 或修订号为 0，且 `readSettings` 答的都是默认值）时，读旧目录的 `settings.json`，只取本版本认识且有效的项（`readSettingsValues`），经 `ctx.writeSettings` 写入；已改过的不覆盖，坏的旧设置忽略，都是默认值时不写。结果记进标记（carried / same / kept / none / unreadable / failed）。
- **说明与日志**：日志只记一行（文件名和个数，没有路径）。复制过、旧目录还在时，快照带 `migration.oldFolder`（主目录写作 `~`，每半分钟看一次旧目录），总览页「设置」页签顶部说明「已从旧版「主线任务」复制数据。旧目录 … 仍在：确认无误后可以手动删除（里面的 backups/ 有你配置文件的完整备份）。0.10 以前开的子对话仍从这里读附件，删掉后它们就读不到这些文件了。」，附英文。
- **Agent 协作**：hook 的识别（命令含 `hook claude-prompt` 且是 `bin/mainline`）和 AGENTS.md 段落的标记都不变，所以旧安装指向 `…/mainline/bin/mainline` 的 hook 和段落在新总览页显示「需要更新」，点「更新」、确认一次即替换。
- **用词**：具体任务在中文里一律叫「支线任务」（英文仍是 task）；PR 与 issue 的分区叫「PR 与 Issue」/ "PRs and issues"（悬停卡片原来叫「线索」）；「线索」只用于查找（用线索找对话、`mainline find <线索>`）；「引申问题」/ spin-off 不变。
- **两次确认**：不能撤销的删除一律连点两次（3 秒内，第一次只把按钮变成「再点一次确认」并经 `aria-live` 读出）：忽略引申问题、删除支线任务、删除里程碑（不论有没有支线任务）、删除主线、删除收藏、清理附件，总览页和胶囊都一样。能撤销的操作一次点击：设状态（胶囊的「完成主线」原来要两次，现在一次，「重新打开」即撤销）、达成阶段、本对话处理、完成支线任务、立即凝练和重新凝练、把 PR 新动态标为已看。胶囊的两次确认支持图标按钮，卡片重绘时保持待确认，切换对话时清掉。
- **已知限制**：悬停卡片只能用鼠标，没有键盘操作，也不支持触屏；这次不做，写进 §11 和 README。
- **许可**：LGPL-3.0-only 不变；LGPL-3.0 是 GPL-3.0 的附加许可，须随附其全文：仓库加上 `COPYING.txt`（gnu.org 的 GPL-3.0 原文，未改动），打包时与 `LICENSE` 一起放进 `dist/second-brain.zip`。文件名用 `COPYING.txt` 而不是常见的 `COPYING`：codexhost 0.25.1 只收后缀已知（`.js`、`.md`、`.txt` 等）或名叫 LICENSE、NOTICE 等的文件，包里有一个不收的文件就整个拒装（只报「Host extension operation failed」），而 codexhost 也会直接装仓库（GitHub 上某个分支的源码包，插件索引在发布没有 zip 时也这样取），所以仓库里的每个文件也都得是它收的（因此也没有 `.d.mts` 类型声明文件，`scripts/package.mjs` 用 JSDoc 写类型）。`scripts/package.mjs` 决定包里放什么，`test/package.test.ts` 按 codexhost 的原样规则（文件名、各类文件的大小、路径、总数和总大小）检查打出来的包和 git 跟踪的全部文件。
- **版本与发布**：0.10.0 是新名字下的第一个版本，`CHANGELOG.md` 记下它。发布走 GitHub Release（用户在 codexhost 的「导入插件 → 本地 .zip」安装），另向 codexhost 插件索引提问：索引的静态检查拒绝任何含 `child_process` 的包，而凝练要启动 `claude`/`codex`、回复提醒要启动 `gh`。公开仓库从一个干净的初始提交开始，完整历史只留在本机。

## 14. PR 新动态的 🔔（0.10.3）

用户在一个 🔔 没被看到的事故之后做的决定，0.10.3 实现：

- **只在用户处理时消失**：快照里对话的切换不再把它的新动态标为已看（原来打开提出 PR 的对话就算看过，可主线胶囊默认关闭，打开对话时什么都看不到）。🔔 只在这几种情况下消失，是否显示着按点击所在的窗口判断：🔔（或悬停卡片最上面的新动态）显示着时点这个对话的侧栏行（`pointerdown` 时记下当时是否显示，`click` 时才算；Enter 也算，同一次只算一回；点行里自己的小按钮如置顶、归档不算），后台 `refs.seenForThread { threadId }` 把来源（`origin`）是这个对话的新动态都标为已看；卡片里的「知道了」和下面列表里的「打开对话」「知道了」用 `refs.seen { key }`；总览页「PR 与 Issue」页签的「跳转」照旧。🔔 不再自己消失，未看的新动态会积起来，所以快照带的未看新动态从最新 10 条放宽到 50 条，免得多出来的没人处理就丢了 🔔。
- **按窗口记焦点**：每个窗口或页面启动时生成一个随机 id，随快照发送（`SnapshotParams.client`），后台按它分别记各自打开的对话；两个 Web 页面停在不同对话上，轮流轮询不再算切换。维护的优先级和真正切换时的 `maintainSoon()` 不变；一分钟没轮询的窗口忘掉，最多记 64 个。没有 id 的旧界面仍按界面种类记。
- **看不到行时的汇总**：对话在侧栏里没有看得见的行（行没有大小、祖先 `display: none`、被收起的分组或滚动的列表裁掉，或根本没列出）时，它的新动态算进侧栏顶部的「🔔 N」：插件自己 overlay 里的一个真按钮（`aria-label`「N 条 PR 与 Issue 新动态」），点开一个列表，每条写仓库和编号、标题、发生了什么、什么时候、来自哪个对话，可以「打开对话」（先标为已看，最多等 1 秒，再打开）或「知道了」。看得见的行照旧挂自己的 🔔。位置在侧栏顶部的一条横线上，先找和宿主的东西（标题、按钮）同一水平的线，再从上往下、再往侧栏上方找；不盖宿主的文字、图标、小按钮和输入框，尽量也不盖整行宽的行、按钮和会滚动的列表；Desktop 避开左上角 macOS 的窗口按钮。codexhost 的 Desktop 和 Web 扩展接口都没有打开插件页面的方法（Desktop 只有 `navigate.openThread`），所以用列表，不跳到总览页。
- **GitHub 轮询**：在用时每分钟一次（原来 3 分钟），否则 10 分钟。「在用」是 10 分钟内有界面调用过后台；每个开着且没隐藏的 Desktop 窗口和 Web 页面每 2 秒（总览页每 3 秒）要一次快照，所以只要有一个开着就一直算在用。这个定义不变，README 照实写明。闲下来以后再有调用时，不提前已经排好的那一轮（最多 10 分钟）。
