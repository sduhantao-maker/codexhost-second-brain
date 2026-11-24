<p align="center"><img src="assets/icon.png" width="88" height="88" alt=""></p>

<h1 align="center">Second Brain · 第二大脑</h1>

<p align="center">
  A <a href="https://github.com/BytePioneer-AI/codex-host">codexhost</a> extension that remembers what each conversation is doing, how far it got, and which replies are worth keeping. Every conversation gets a visible mainline: what it is doing, the milestones it has reached and the task at hand. Rest the pointer on a conversation in the sidebar to see it, or turn on a capsule in the conversation header.
</p>

<p align="center"><a href="#english">English</a> · <a href="#中文">中文</a></p>

## 中文

在多个对话之间来回切换，注意力会被削弱：处理一个问题时看到新问题，下意识就在同一个对话里接着做了；一个问题开了好几个对话，最后记不清哪个做到了哪一步；值得留下的回复散在各处，过后也找不回来。第二大脑替你记着：每个对话在做什么、做到哪一步、哪段回复值得留下。每个对话都有一条看得见的主线。

- **一个对话一条主线，由模型凝练。** 主线写这个对话在做什么，并配上有辨识度的标签，例如「修复登录页在窄屏下错位」#shop-web #登录页 #PR #42。每轮回复结束后一两分钟内，插件调用小模型读这个对话，写出标题和标签，并识别里程碑节点：哪些阶段已经达成，现在在哪一阶段，接下来计划做什么。看出目标已完成或已放下时把对话标为已完成，超过 7 天没动的标为暂停；你手动设过状态或 Agent 正在做一项支线任务时不改状态。默认「跟随对话」：Claude Code 的对话用 Claude Haiku（经你已登录的 Claude Code），Codex 的对话用 Codex。其他 Agent（如 pi、DeepSeek、Grok）的对话默认不发给任何模型；要凝练它们，在设置里为它们选一个模型。找不到 `claude` 或 `codex` 命令时，这次凝练报错，不会改用另一家。你在总览页手动改过的标题、标签和里程碑保持不动，已达成的里程碑不会被撤销。你删掉的主线不会被自动凝练或整理旧对话写回来，除非你再点「立即凝练」「建立主线」，或者 Agent 运行 `mainline new`。
- **里程碑和支线任务。** 主线下面是里程碑，也就是阶段性成果：✓ 已达成、● 当前、○ 计划。两个里程碑之间是具体的支线任务，由对话里的 Agent 边做边记。一条主线最多 30 个里程碑：都已达成、又要开新阶段时，最早达成的一个（先挑你没加过、没改过名的）让出位置，它没做完的支线任务跟到新阶段；手动加第 31 个时会提示已满。
- **整理旧对话。** 在总览页「设置」里点「整理旧对话：最多把 N 个对话发给模型」，3 秒内再点一次确认（也可以运行 `mainline summarize --all`），插件在后台把旧对话凝练一遍，已按最新内容凝练过的跳过。每次整理里每个对话最多发送一次：发送前记在 `backfill-tried.json`，重启后也不重发，失败的不再重试（整理结束或停止时删掉这个文件）。主线已有 2000 条时，整理不再给没有主线的对话新建主线，这些对话不发送，进度里写明有几个。N 是真正会发给模型的对话数，不含按设置不发送的其他 Agent 的对话，也不含因主线已满不发送的对话。总览页显示进度，随时可以点「停止」：正在进行的那次做完，其余不再发送。关掉自动凝练不影响你开始的整理。
- **侧栏悬停就能看。** 鼠标在侧栏的对话上停 0.4 秒，旁边弹出这个对话的主线、里程碑节点和当前的支线任务，不用点开。停留时行上还显示进度，例如 ◆ 2/4。Codex Desktop 和 codexhost Web 自己也会弹出会话预览，主线卡片会排在预览的下面或旁边，不会叠在一起。
- **可选的主线胶囊。** 默认只在侧栏悬停时显示主线。在设置里打开「对话标题栏也显示主线胶囊」后，标题栏会多一枚胶囊，显示主线、当前里程碑、正在做的支线任务和进度，点开可以达成阶段、加支线任务、改标题和标签。
- **开子对话。** 在侧栏悬停卡片底部点「＋ 开子对话」，写一句新问题，再连点两次「开子对话」，就会以当前对话为父对话新开一个对话。可以附带照片、文件或视频：点输入框旁的 📎，或者把截图粘贴进输入框、把文件拖进卡片，每个文件最大 500 MB，最多 10 个，合计不超过 1 GB。附件的写法和 codexhost 自己附加文件时一样，Claude Code 子对话直接看到图片，视频和其他文件由 Agent 按路径打开。Agent 记下的引申问题也列在卡片里，同样可以开成子对话；也可以让 Agent 运行 `mainline spawn`，已经开过子对话的引申问题会直接给出那个子对话，不再开第二个。子对话的第一条消息先写问题本身，再用一行写背景（父对话的标题和当前阶段），并标明是模型概括、仅供参考。8 秒内等不到 codexhost 答复时，卡片显示「正在打开子对话」，输入的问题和附件先留着；子对话在后台继续打开，开好后出现在本对话下方，卡片随之说明已开好。这期间再点一次不会开第二个。你删掉主线的对话上开子对话，子对话开出来之前什么都不改；开出来后才给这个对话记一条主线挂上链接，它仍算你删掉的主线，模型不凝练它，直到你要求凝练或建立主线。装了侧栏委派树插件时，子对话缩进显示在本对话下面；子对话的主线上标明它来自哪个对话。
- **还没凝练的对话标「未凝练」。** 比如新对话的第一轮还没结束、装插件以前就有且之后没再用过的对话（可用「整理旧对话」一次凝练）、关掉自动凝练以后的对话、当天 200 次自动凝练用完以后的对话、凝练失败后等着重试的对话（30 分钟后重试，之后每次间隔加倍，最长 8 小时；对话有新回复或点「立即凝练」时马上重试）、主线已满 2000 条又没有能让出位置的主线时的新对话、你删掉主线的对话、读不出内容的对话，以及按设置不发给模型的其他 Agent 的对话。这时卡片上的标题、标签和起因由对话标题、第一句话、工作区和提到的 PR 拼出来，不调用模型，也不写入文件。开着自动凝练时，对话有新回复后一两分钟内模型会凝练它；也可以在悬停卡片里点「立即凝练」。其他 Agent 的对话没有选模型时，点「立即凝练」会在卡片里说明是哪项设置。
- **用线索找对话。** 输入编号、链接、标签、关键词、里程碑或当时问的话，都能找到对应的对话并跳过去。
- **PR 与 Issue 的回复提醒。** 插件会扫描 codexhost 的全部对话，记下每个 GitHub PR 和 issue 来自哪个对话、第几轮，以及当时你问的话。有人评审、合并或评论 #42 时，侧栏里提出它的那个对话行上会挂一个 🔔，悬停时卡片最上面显示这条新动态，总览页「PR 与 Issue」页签里它排在最前。只有有人评审、合并或发了新评论才提醒；机器人（如 CodeRabbit）的评论和评审、改评论、CI 结果，以及你自己的操作都不提醒。

支持 Codex Desktop，以及 codexhost 自带窗口和 Web。

### 安装

需要支持统一 Host 扩展（`manifestVersion: 2`）的 codexhost，也就是 0.24.0 及以上。在 macOS 上用 codexhost 0.25.1 测试过，Windows 和 Linux 未经验证。

- **本地 .zip**：从 [Releases](../../releases) 下载 `second-brain.zip`（也可以运行 `npm ci && npm run package` 自己打包，得到 `dist/second-brain.zip`），在「插件 → 导入插件 → 本地 .zip」选择它，然后启用。
- 用过开发中的旧版「主线任务」的，见下面的「从开发中的旧版「主线任务」升级」。
- 侧栏委派树插件可选。装了它，子对话会缩进显示在父对话下面。

### 使用

1. 打开「第二大脑」页面：Desktop 在「设置 → 插件页面」，Web 在左侧「插件」工作区顶部的标签。
2. 在总览页的「Agent 协作」里点「查看改动」，确认后再安装：
   - Claude Code：在 `~/.claude/settings.json` 的 `hooks.UserPromptSubmit` 里加一条 hook；
   - Codex：在 `~/.codex/AGENTS.md` 末尾加一段带标记的说明，只有一句话。

   修改前会把原文件完整备份到插件数据目录的 `backups/`，卸载时只删这一条 hook 或这一段说明。配置文件读不了时不会当成不存在，总览页用页面的语言说明原因，不安装。这两个文件是软链接（比如放在 dotfiles 仓库里）时，改的是链接指向的文件，链接保持不变；指向的文件写不了时说明它在哪里，什么都不改。装好后：
   - Claude Code 在每个会话的第一条消息时收到本对话主线的全文（主线、里程碑、支线任务和约定）。之后每 30 条消息、超过 12 小时或约定变化时再给一次全文；其间只在标题或状态、进度、当前里程碑、正在做的支线任务或未处理的引申问题数变化时加一行状态，没变化就什么都不加。
   - Codex 在对话的第一条消息时运行一次 `mainline show` 并照做。`show` 第一次打印全文，之后打印一行状态，`mainline show --full` 打印全部。不在 codexhost 里的 Codex 会话，`show` 什么都不打印。
   - Agent 用 `mainline doing`、`task`、`done`、`spinoff`、`link` 记录支线任务、引申问题和 PR 链接。对话还没有主线时，`doing`、`task`、`done "…"`、`spinoff` 以「未凝练」时显示的标题和标签为起点建立主线；你删掉过主线的对话除外，命令会说明是你删的。标题、标签、里程碑和状态由模型凝练；关掉自动凝练时由 Agent 用 `mainline new`、`plan`、`reach` 等维护。
3. 不装 Agent 协作也能用：开着自动凝练时模型会写出主线；也可以在侧栏悬停卡片点「立即凝练」，或在总览页「没有主线」页签的对话上点「建立主线」，再手动加里程碑和支线任务。
4. 在总览页「设置」页签选择同一对话出现新问题时 Agent 的做法（需要装好 Agent 协作）：先问我（默认）、只记录不打断、不检查。
5. 要找一个对话时，在总览页顶部的搜索框输入线索：编号、链接、标签或关键词都可以。
6. 收藏重要的话：在对话里选中一段文字，点弹出的「★ 收藏」；或者在聊天里说「收藏上一条回复」（需要装好 Agent 协作），Agent 会存下上一条回复的全文。收藏都在总览页的「收藏」页签里，每次列出 100 条、每条先显示前 600 字，可以搜索（在全文里找）、写备注、复制（复制全文），点「展开全文」看整段，点「跳回原文」会打开那个对话并高亮这段文字。收藏里的引用最多显示 8 层嵌套，更深的按文字显示。
7. 不能撤销的删除都要在 3 秒内连点两次：忽略引申问题，删除支线任务、里程碑、主线或收藏，清理附件，在总览页和胶囊里都一样。第一次点击只把按钮变成「再点一次确认」，读屏会读出来。能撤销的操作点一次就生效：设状态（包括胶囊上的「完成主线」，可以「重新打开」）、达成阶段、本对话处理、立即凝练和重新凝练、把 PR 新动态标为已看。

Agent 使用的命令装在 `~/.codexhost/host-extension-data/second-brain/bin/mainline`，也可以手动运行，`mainline --help` 列出全部子命令。

从 0.2 升级时，旧主线会自动迁移到它的主对话上（Agent 建立它的那个对话，否则最早加入的那个）：已完成的事变成已达成的里程碑，正在做的事照旧，旧版的「支线待办」（先记下、暂不处理的问题）变成引申问题；只是挂在主线上的其他对话不再关联。迁移前的状态文件留作 `state.v1.json`（见下面的文件列表）。

### 从开发中的旧版「主线任务」升级

0.10 以前，插件在开发中叫「主线任务」（id `mainline`）。改名后 codexhost 给它一个新的数据目录：第二大脑第一次启动时，如果新目录还没有数据，就把旧目录 `~/.codexhost/host-extension-data/mainline/` 里的数据和改过的设置复制过来，只复制一次（不复制 `backups/`），旧目录原样保留。之后在 codexhost 里卸载旧版（保留数据），再在「第二大脑 → 设置 → Agent 协作」里，对显示「需要更新」的 Claude Code 和 Codex 点「更新」。旧目录确认无误后可以手动删除，但 0.10 以前开的子对话还从那里读附件。

### 数据与隐私

插件的数据存在本机的 `~/.codexhost/host-extension-data/second-brain/`。插件向外发送的只有下面两类内容。

**发给模型的对话内容。** 凝练时，插件把对话最近约 40 轮的文字（每轮截断）发给这个对话对应模型的服务商：经你已登录的 Claude Code 发给你的 Claude Code 所用的服务商，或经 Codex 命令行发给你的 Codex 所用的服务商。其他 Agent 的对话只有在设置里为它们选了模型时才发送。发送前先遮掉常见形式的密钥、令牌和密码（如 `sk-…`、`ghp_…`、`AKIA…`、JWT、私钥块、`Bearer …`、链接里的密码、`password=…`），并去掉用户消息前的附件清单。

- 调用在空的私有目录里进行，不运行你的钩子、插件和 MCP，不在 Claude Code 或 Codex 的历史里留下会话，不带 codexhost 的会话变量。
- Codex 关掉执行命令、读本机文件、看图、浏览器、电脑操作、记忆等功能，关掉网页搜索，支持时加 `--ignore-rules`，沙箱只读；Claude 用 `--tools ""`，支持时用低推理强度。Codex 只有在提示小模型对你的账号不可用时，才换默认模型重试一次。
- 一次 Codex 凝练会带上 Codex 自己约 16–17k 个输入 token 的说明。不想要这部分开销，在设置里改用 Claude Haiku。
- 自动凝练每天最多 200 次，同一对话最多 10 分钟一次，可以在设置里关掉；关掉后排队的自动凝练直接丢掉。凝练失败的对话 30 分钟后自动重试，之后每次间隔加倍，最长 8 小时；对话有新回复或你点「立即凝练」时马上重试。失败但已发出的调用照样计入当天次数。每天各模型、各原因（自动、手动、整理旧对话）的调用次数记在 `summary-counts.json`，保留 14 天，所以重启后限额照样算；设置页显示今天的次数。每次调用在 `backend.log` 记一行：模型、原因、对话短编号、耗时、成败，不含对话内容。

**GitHub。** 开着回复提醒时，插件用你已登录的 `gh` 读 GitHub 通知：最近 10 分钟用过插件界面时每 3 分钟一次，否则每 10 分钟一次。某个 PR 或 issue 有新通知时，再读它最近的评论、评审和合并情况，判断要不要提醒。每轮另外最多补查 20 个 PR 或 issue 的标题和状态（进行中的 30 分钟查一次，已关闭或合并的一天一次）；你在悬停卡片、「PR 与 Issue」页签、搜索或 `mainline find` 里看到的 PR，上次查询超过一分钟就再查一次（每次最多 6 个；页签里是最新的 6 个）。只读，不会把通知标为已读；可以在设置里关闭。

插件后台还用 codexhost 命令行的本机凭据调用 codexhost 的本机接口：读对话列表、标题、状态、委派关系和对话内容，用来建立 PR 索引、生成草稿和凝练；只有在你确认开子对话时，才调用委派接口新开一个对话。

本机保存的文件（JSON 文件都紧凑写入）：

- `state.json`：主线；每个 Claude Code 对话最近一条消息（hook 记录，截断到 300 字，遮掉密钥，14 天不更新就删掉）；你删掉的主线对应哪些对话（最多 2000 个）。删除主线时一并删掉这个对话存的最近一条消息。主线最多保留 2000 条：超出时先删已完成的、再删最旧的，但你手动改过的（标题、标签、状态或里程碑）、还有未完成的支线任务或正在做的主线不会被删。没有能删的，或者新建的这条自己会最先被删时，不新建：自动凝练跳过这个对话，手动凝练和建立主线会说主线已满；开出来的子对话只记下链接。
- `refs.json`：PR 与 Issue 索引和对话记录：对话标题、工作区的文件夹名（不存完整路径）、运行它的 Agent、对话开头的请求，以及每个 PR 出现那一轮的请求；请求各最多 200 字。codexhost 不再列出的对话会被忘掉，除非有 PR 提到它，或它有主线、最近一条消息或收藏。旧版本存下的请求和对话开头，后台启动时补遮一次密钥。
- `github-poll.json`：上次读 GitHub 通知的时间。
- `summary-counts.json`：模型调用次数，见上。
- `backfill-tried.json`：正在进行的整理已经发送过哪些对话，整理结束或停止时删掉。
- `context/`：每个对话给 Agent 看过什么，只存指纹（摘要值）、时间和 Claude 会话编号，不存原文；3 天没用就删掉。
- `favorites.json`：收藏。
- `attachments/`：开子对话时附带的文件；`attachments/owners.json` 记着每份文件属于哪个子对话。子对话开出后文件就归它，以后还会按路径读，所以不会自动删除；在总览页「设置」里可以查看占用并清理。后台也检查一个子对话的附件合计不超过 1 GB。codexhost 拒绝开子对话或根本连不上时，这次附带的文件马上删掉；请求发出后没等到回答时，文件保留但不记归属，「全部清理」会清掉。上传后没用上的文件一小时后清掉。
- `backups/`：安装或卸载 Agent 协作前 `~/.claude/settings.json` 和 `~/.codex/AGENTS.md` 的完整副本。里面可能有登录凭据，所以只有你能读；每个文件最多留 3 份，超过 30 天的在下次备份时删掉。
- `settings.json`：插件设置，由 codexhost 写入。
- `bin/`：Agent 使用的 `mainline` 命令，后台每次启动时重新放进来。
- `backend.log`（满约 256 KB 换成 `backend.log.1`）：后台日志，记操作、次数和出错原因，不含对话内容，见「报告问题」。
- `state.v1.json`：从 0.2 升级时留下的旧状态完整副本（可能含当时未遮密钥的最近一条消息），不会自动删除。
- `migrated-from-mainline.json`：从开发中的旧版「主线任务」复制数据的时间和复制了什么（只有文件名和个数），有它就不再复制；复制时短暂存在的暂存目录 `.migrating-from-mainline/` 用完即删。
- `<名字>.corrupt-<时间>.json`：读不了的数据文件（`state.json`、`favorites.json`、`refs.json`、`summary-counts.json`、`attachments/owners.json` 和 `context/` 里的记录）在被覆盖之前挪到这里，每个文件最多留 3 份。更新版本的插件写的数据文件既不挪走也不覆盖：读写都会报错，请把插件更新到最新版本。
- `model-runs/`：调用模型时的临时目录，调用结束就删，后台启动时清空。
- 写入时短暂存在的锁目录（`*.lock`，以及更短暂的 `*.lock.guard`），用完即删。锁里记着持有者，持有期间每 0.5 秒刷新；进程中途退出留下的锁，10 秒没刷新、再过 1.5 秒仍没变化时才被接管，一次只有一个等待者接管，持有者只删自己的锁。

### 卸载

1. 先在「第二大脑 → 设置 → Agent 协作」里，对 Claude Code 和 Codex 各点「卸载」，再点「确认修改」。卸载插件本身不会改 `~/.claude/settings.json` 和 `~/.codex/AGENTS.md`，不先卸载的话，那条 hook 和那段说明会留在里面。插件卸载或停用后，它们运行的 `mainline hook` 和 `mainline show` 什么都不说、什么都不记；`mainline` 的其他命令照常读写数据目录。
2. 再在 codexhost 里卸载插件。
3. codexhost（至少到 0.25.1）卸载插件时保留数据目录 `~/.codexhost/host-extension-data/second-brain/`：里面有主线和每个对话最近一条消息（`state.json`）、PR 索引和对话开头的请求（`refs.json`）、收藏、开子对话时附带的文件、Agent 协作改动前的配置备份（`backups/`，可能含登录凭据）、日志和 `mainline` 命令，完整列表见上面。不再需要时，可以手动删掉整个目录。

### 对 codexhost 的负载

- 对话的标题和状态来自一次共用的对话列表（最近更新的 50 个，最多 20 秒一次），不逐个读对话。只有打开着的对话（最多 15 秒一次）、列表说在运行的对话（1 分钟）和页面要显示却不在列表里的对话（5 分钟）才单独读，同时最多读 2 个；读失败后先等 1 分钟，之后每次加倍，最长 15 分钟。Codex Desktop 在前台时，它上报的委派树优先。
- 页面只在看得到的内容变了时才重新拉取全部数据；总览页隐藏时不轮询，「PR 与 Issue」页签显示时才查 PR 的最新状态。
- codexhost 每条答复最多 2 MB，后台每条答复最多 1.5 MB：快照超过 1 MB 时，先截短最近请求，再把最不需要的对话（已完成、最旧的优先）只发提纲（标题、状态、当前里程碑和进度），总览页展开它时再取全；收藏按页列出，PR 与 Issue 从最新的开始，放不下的写明数目。
- codexhost 给每次调用 10 秒：开子对话、立即凝练和开始整理旧对话最多等 8 秒，没做完的在后台继续。插件停止时立即中断对 codexhost 和 `gh` 的请求，1 秒内结束。
- 诊断默认关闭。需要时在 Desktop 或 Web 的开发者控制台里设置 `localStorage["codexhost-mainline:debug"] = "1"`。

### 报告问题

- 后台日志是数据目录里的 `backend.log`（上一份是 `backend.log.1`）。它记后台做了什么：启动（插件版本、Node 版本和平台）、安装或卸载 Agent 协作、每次模型调用（模型、原因、对话短编号、耗时、成败）、GitHub 上有动静的 PR 和 issue（仓库和编号）、读不出的对话的短编号，以及出错原因。不含对话内容；主目录写作 `~`，路径里的用户名写作 `<user>`，但仓库名照写，贴出来之前先看一遍。
- 胶囊、悬停卡片或「★ 收藏」的位置不对，或认不出当前对话时，打开诊断：在 Desktop 或 Web 的开发者控制台里运行 `localStorage["codexhost-mainline:debug"] = "1"`，再重现一次。这个界面会把它看到的页面结构（当前对话短编号、侧栏行数、标题栏和胶囊的位置等）写进 `backend.log`。运行 `localStorage.removeItem("codexhost-mainline:debug")` 关闭。

### 已知限制

- 后台接口分不出请求来自本机还是远程的 codexhost Web 会话：拿到 codexhost Web 会话的人，能做总览页和悬停卡片能做的一切。
- Claude Code 的 hook 也会在继承了 codexhost 对话环境的嵌套 Claude 运行里执行（例如对话里的 Agent 自己运行 `claude`），把那里的消息记成这个对话的最近一条消息。
- Claude Code 压缩上下文后，主线全文要等 30 条消息后的那次刷新、新会话或 12 小时后才会再给。
- 插件请 codexhost 开子对话时最多等 20 秒的答复；这之后才开出来的子对话不会挂到引申问题上，再点一次可能开出第二个。
- 只在 macOS 上测试过，Windows 和 Linux 没有验证。
- 悬停卡片只能用鼠标打开：键盘打不开，触屏也打不开（触屏没有悬停）。主线胶囊又默认关闭，所以只用键盘或在手机上时，对话里看不到主线；可以在设置里打开主线胶囊（它能用键盘打开），或在「第二大脑」页面查看。

## English

Switching between many conversations wears attention thin: a new problem spotted halfway through a task gets handled in the same conversation, and one task spreads over several conversations until nobody remembers which one got where, while the replies worth keeping end up scattered. Second Brain remembers what each conversation is doing, how far it got, and which replies are worth keeping: every conversation gets a visible mainline.

- **One conversation, one mainline, written by a model.** The mainline says what the conversation is doing, with tags that make it easy to recognize, such as "Fix the login page layout on narrow screens" #shop-web #login-page #PR #42. A minute or two after each reply, a small model reads the conversation, writes the title and tags, and finds the milestones: which stages are reached, which one is in progress, what is planned next. It also marks a conversation done when its goal looks reached or dropped, and paused after 7 quiet days, except when you set the status by hand or an agent is in the middle of a task. By default the model follows the conversation: Claude Code conversations use Claude Haiku (through your Claude Code login), Codex conversations use Codex. Conversations of other agents (pi, DeepSeek, Grok, …) go to no model by default; choose a model for them in the settings to summarize them. When the `claude` or `codex` command is missing, that summary fails with an error; it never goes to the other provider instead. Titles, tags and milestones you edit in the overview stay, and reached milestones are never undone. A mainline you delete is not brought back by automatic summaries or the backfill, unless you select **Summarize now** or **Create mainline** again, or an agent runs `mainline new`.
- **Milestones and tasks.** Under the mainline are milestones, the results of each stage: ✓ reached, ● current, ○ planned. Between two milestones are the concrete tasks, which the agent in the conversation records as it works. A mainline has at most 30 milestones: when all are reached and a new stage begins, the earliest reached one (one you did not add or rename, when there is one) makes room, and its unfinished tasks go on in the new stage; adding a 31st by hand says the mainline is full.
- **Older conversations.** In the overview's **Settings**, select **Summarize older conversations: send up to N to the model** and select it again within 3 seconds to confirm (or run `mainline summarize --all`). The extension then summarizes the older conversations in the background, skipping those already summarized as they are now. One backfill sends each conversation at most once: it is written down in `backfill-tried.json` before it is sent, so a restart sends none again, and one that failed is not retried (the file is deleted when the backfill finishes or stops). Once there are 2,000 mainlines, the backfill gives no conversation a new mainline: those are not sent, and the progress says how many. N is what it will really send to a model; other agents' conversations that the settings keep from models are not counted, nor those left out because the mainlines are full. The overview shows the progress, and **Stop** ends it at any time: a summary in progress finishes, nothing else is sent. Turning automatic summaries off does not stop a backfill you started.
- **A glance from the sidebar.** Rest the pointer on a conversation in the sidebar for 0.4 seconds and its mainline, milestones and current tasks appear beside it, without opening it. The row also shows the progress, such as ◆ 2/4. Codex Desktop and codexhost Web show their own preview of the conversation too; the mainline card goes under it or beside it instead of on top.
- **An optional capsule.** By default the mainline shows only on hover in the sidebar. Turn on **Also show the mainline capsule in the conversation header** to get a capsule with the mainline, the current milestone, the task in progress and the progress; select it to reach a milestone, add tasks, or edit the title and tags.
- **Child conversations.** At the bottom of the sidebar hover card, select **+ Child conversation**, write the new problem in one line and select **Open child** twice: a new conversation starts under this one. Photos, files and videos can go along: select 📎 beside the field, paste a screenshot into it, or drop files on the card (up to 10 files of at most 500 MB each, 1 GB in all). They are named the way codexhost names attached files, so a Claude Code child sees the pictures, and agents open videos and other files from their paths. Spin-offs the agent noted are listed in the card too and open the same way, or the agent runs `mainline spawn`; for a spin-off that has a child already, that child is given back instead of opening a second one. The child's first message is the problem itself, then one line of background (the parent's title and current stage), marked as written by a model and for reference only. When codexhost has not answered within 8 seconds, the card says the child conversation is still opening and keeps what you typed and attached; the child goes on opening in the background, shows up under this conversation once it opens, and the card then says so. Selecting it again meanwhile opens no second child. On a conversation whose mainline you deleted, nothing changes until the child opens; then the conversation gets a mainline to hold the link, still counts as deleted, and no model summarizes it until you ask for a summary or create the mainline. With the sidebar delegation tree extension, child conversations are indented under this one; their mainline names the conversation they came from.
- **"Not summarized" until a model has written the mainline.** For example while a new conversation's first turn runs, for conversations from before the extension that were not used since (**Summarize older conversations** does them at once), after automatic summaries are turned off, once the day's 200 automatic summaries are used up, while a failed summary waits for its next try (after 30 minutes, then twice as long each time up to 8 hours; at once after a new reply or **Summarize now**), for a new conversation when there are 2,000 mainlines and none can make room, for a conversation whose mainline you deleted, one that cannot be read, or another agent's conversation the settings keep from models. The card then shows a title, tags and origin taken from its title, first message, workspace and the PRs it mentions. This uses no model and saves nothing. With automatic summaries on, a model summarizes a conversation a minute or two after a new reply; or select **Summarize now** in the hover card. For another agent's conversation with no model chosen, **Summarize now** says in the card which setting decides.
- **Find a conversation by any clue.** A number, link, tag, words, milestone or what you asked there finds the conversation and takes you to it.
- **Replies to your PRs and issues.** The extension reads every codexhost conversation and records which conversation and turn each GitHub PR and issue came from, and what you asked there. When someone reviews, merges or comments on #42, the sidebar row of the conversation it came from gets a 🔔, its hover card shows the news first, and it moves to the top of the overview's **PRs and issues** tab. Only a review, a merge or a new comment by a person rings it: comments and reviews by bots such as CodeRabbit, edited comments, CI results and your own actions do not.

Works in Codex Desktop and in codexhost's own window and Web.

### Install

Requires a codexhost with unified Host extensions (`manifestVersion: 2`), that is 0.24.0 or later. Tested on macOS with codexhost 0.25.1; Windows and Linux are untested. Download `second-brain.zip` from [Releases](../../releases) (or run `npm ci && npm run package` to build `dist/second-brain.zip`), then choose **Plugins → Import plugin → Local .zip** with it and turn it on. If you used the development version "Mainline", see **Upgrading from the development version "Mainline"** below. The sidebar delegation tree extension is optional; with it, child conversations are indented under their parent.

### Use

1. Open **Second Brain**: on Desktop under **Settings → Plugin pages**, on Web as a tab of the **Plugins** workspace.
2. Under **Agent integration**, select **Show change** and then install. Claude Code gets one hook in `~/.claude/settings.json`; Codex gets one marked section of one sentence in `~/.codex/AGENTS.md`. The original file is copied in full to `backups/` in the extension's data folder first, and removing the integration deletes only that hook or section. A settings file that cannot be read is not taken for a missing one: the overview says why, in its language, and nothing is installed. When either file is a symbolic link (kept in a dotfiles repository, say), the file it points to is changed and the link stays; when that file cannot be written, the overview says where it is and nothing changes. Once installed:
   - Claude Code gets the full text of the conversation's mainline (mainline, milestones, tasks and rules) with the first message of each Claude session, and again after 30 messages, after 12 hours, or when the rules change. In between it gets one status line, only when the title or status, the progress, the current milestone, the task in progress or the number of open spin-offs changed; otherwise nothing.
   - Codex runs `mainline show` once at the first message of a conversation and follows it. `show` prints the full text the first time and a status line after that; `mainline show --full` prints everything. In a Codex session outside codexhost, `show` prints nothing.
   - Agents record tasks, spin-offs and PR links with `mainline doing`, `task`, `done`, `spinoff` and `link`. In a conversation without a mainline, `doing`, `task`, `done "…"` and `spinoff` start one from the title and tags shown while it is "Not summarized", except where you deleted the mainline: then the command says you did. The model writes the title, tags, milestones and status; with automatic summaries off, agents keep them with `mainline new`, `plan`, `reach` and the like.
3. Without the integration: with automatic summaries on, a model writes the mainlines; you can also select **Summarize now** in the hover card, or **Create mainline** on a conversation in the overview's **No mainline** tab, and add milestones and tasks yourself.
4. In the overview's **Settings** tab, choose what agents do when a new problem shows up in the same conversation (with the agent integration installed): ask first (default), note it and keep going, or do not check.
5. To find a conversation, type a clue in the search box at the top of the overview: a number, link, tag or words.
6. To keep something important, select text in a conversation and click the **★ Save** button that appears, or say "save the last reply" in the chat (with the agent integration installed) and the agent saves the whole previous reply. Saved passages are in the overview's **Favorites** tab, 100 at a time with the first 600 characters of each: search them (the whole text is searched), add notes, copy them (the whole text is copied), select **Show all** to read one in full, or select **Go to passage** to open the conversation with the passage highlighted. Quotes nest at most 8 deep there; deeper ones read as text.
7. Whatever cannot be undone takes two clicks within 3 seconds: dismissing a spin-off, deleting a task, a milestone, a mainline or a saved passage, and clearing attachments, in the overview and in the capsule alike. The first click only turns the button into **Click again to confirm**, and screen readers hear it. What can be undone takes one click: setting a status (the capsule's **Finish** too, undone with **Reopen**), reaching a stage, handling a spin-off here, **Summarize now** and **Summarize again**, marking PR news seen.

The command agents run is installed at `~/.codexhost/host-extension-data/second-brain/bin/mainline`; `mainline --help` lists its subcommands.

Upgrading from 0.2 moves each old mainline to its main conversation (the one an agent put on it, else the first to join): done items become reached milestones, the task in progress stays, and parked items (problems noted for later) become spin-offs. Conversations that were only attached to a mainline are no longer linked to it. The state file from before is kept as `state.v1.json` (see the files below).

### Upgrading from the development version "Mainline"

Before 0.10, while it was being developed, the extension was called Mainline (id `mainline`). With the new name codexhost gives it a new data folder: at its first start, if that folder has no data yet, Second Brain copies the data and the changed settings of the old folder `~/.codexhost/host-extension-data/mainline/` over, once (not `backups/`), and leaves the old folder as it was. Then uninstall Mainline in codexhost, keeping its data, and select **Update** for Claude Code and Codex where **Second Brain → Settings → Agent integration** says **Needs update**. You may delete the old folder by hand once everything looks right, but child conversations opened before 0.10 still read their attachments from it.

### Data and privacy

The extension keeps its data in `~/.codexhost/host-extension-data/second-brain/` on this machine. It sends out only the two kinds of content below.

**Conversation text sent to a model.** For a summary, the extension sends the text of the latest 40 or so turns (each cut short) to the provider of the model set for that conversation: through your Claude Code login to the provider your Claude Code uses, or through the Codex command line to the provider your Codex uses. Other agents' conversations are sent only if you choose a model for them in the settings. Before anything is sent, secrets of common shapes are masked (such as `sk-…`, `ghp_…`, `AKIA…`, JSON Web Tokens, private key blocks, `Bearer …`, passwords in links, `password=…`), and the list of attached files before a user message is left out.

- Each call runs in an empty private folder, with none of your hooks, plugins or MCP servers and none of codexhost's session variables, and leaves no session in Claude Code's or Codex's history.
- Codex runs with running commands, reading local files, viewing images, the browser, computer use, memories and similar features turned off, web search disabled, `--ignore-rules` where Codex supports it, and a read-only sandbox. Claude runs with `--tools ""` and low effort where supported. Only when Codex reports the small model as not available to your account is the call tried once more with Codex's default model.
- A Codex summary carries about 16–17k input tokens of Codex's own instructions per call. To avoid that cost, choose Claude Haiku in the settings.
- Automatic summaries run at most 200 times a day and at most every 10 minutes per conversation; turn them off in the settings, which also drops the automatic ones waiting. A summary that failed is tried again after 30 minutes, then twice as long each time up to 8 hours; at once after a new reply or when you select **Summarize now**. Failed calls that were sent count for the day like any other. Each day's calls by model and reason (automatic, asked for, backfill) are counted in `summary-counts.json` for 14 days, so the daily limit holds across restarts; the settings tab shows today's counts. Each call writes one line to `backend.log`: model, reason, short conversation id, time taken and outcome, no conversation text.

**GitHub.** With reply alerts on, the extension reads GitHub notifications through your `gh` login: every 3 minutes when its views were used in the last 10 minutes, otherwise every 10 minutes. When a PR or issue has a new notification, it reads that one's latest comments, reviews and merge to decide whether it rings. Each round it also fills in the title and state of up to 20 PRs and issues (open ones every 30 minutes, closed or merged ones once a day), and a PR you see in a hover card, the **PRs and issues** tab, a search or `mainline find` is looked up again when its last lookup is over a minute old (at most 6 at a time; in the tab the 6 newest). All of this is read only and never marks notifications as read; turn it off in the settings.

The backend also calls codexhost's local API with the local credential of codexhost's own command line: it reads the conversation list, titles, states, delegation links and conversation text to build the PR index, the drafts and the summaries, and it starts a conversation through the delegation API only when you confirm a child conversation.

Files kept on this machine (the JSON files are written compactly):

- `state.json`: the mainlines; the latest message of each Claude Code conversation (recorded by the hook, cut to 300 characters, secrets masked, dropped after 14 days without an update); and which conversations' mainlines you deleted (at most 2000). Deleting a mainline also deletes that conversation's stored latest message. At most 2,000 mainlines are kept: past that, finished ones go first, then the oldest, but never one you edited by hand (its title, tags, status or milestones) or one with a task unfinished or in progress. When none can go, or the new one would itself be the first to go, no new mainline is made: automatic summaries leave that conversation out, **Summarize now** and **Create mainline** say the mainlines are full, and a child conversation that opened only gets its link recorded.
- `refs.json`: the PR and issue index and what it knows of each conversation: its title, the name of its working folder (not the full path), the agent that runs it, its first request, and the request of each turn a PR came up in; each request at most 200 characters. Conversations codexhost no longer lists are forgotten, unless a PR names them or they have a mainline, a latest message or a saved passage. Requests and first requests stored by earlier versions are masked once when the backend starts.
- `github-poll.json`: when GitHub notifications were last read.
- `summary-counts.json`: the model calls, see above.
- `backfill-tried.json`: the conversations the backfill under way has sent; deleted when it finishes or stops.
- `context/`: what each conversation's agent has been shown, as fingerprints, times and the Claude session id only, no text; deleted after 3 days unused.
- `favorites.json`: saved passages.
- `attachments/`: files sent along with child conversations; `attachments/owners.json` records which child each one went with. Once the child exists the files are its own, and it may read them again later from their paths, so they are not deleted automatically; the overview's settings show how much they take and clear them. The backend too keeps the files of one child to 1 GB. When codexhost refuses the child or cannot be reached, the files sent with it are deleted at once; when the request went out but no answer came, they are kept with no owner on record, and **Clear all** clears them. Uploads no child used are cleared after an hour.
- `backups/`: full copies of `~/.claude/settings.json` and `~/.codex/AGENTS.md` made before the integration is installed or removed. They can hold credentials, so only you can read them; at most 3 are kept per file, and any older than 30 days are deleted when the next backup is made.
- `settings.json`: the extension's settings, written by codexhost.
- `bin/`: the `mainline` command agents run, put there again each time the backend starts.
- `backend.log` (moved to `backend.log.1` at about 256 KB): the backend's log of what it did, counts and why something failed, no conversation text; see **Reporting a problem**.
- `state.v1.json`: a full copy of the state as 0.2 left it when you upgraded (it may hold a latest message from then with secrets unmasked); never deleted automatically.
- `migrated-from-mainline.json`: when the data of the development version Mainline was copied over and what was copied (file names and counts only); with it there, nothing is copied again. The staging folder `.migrating-from-mainline/` exists only while the copy is made.
- `<name>.corrupt-<time>.json`: a data file that could not be read (`state.json`, `favorites.json`, `refs.json`, `summary-counts.json`, `attachments/owners.json` or a record in `context/`), moved aside before it is replaced; the newest 3 are kept per file. A data file a newer version of the extension wrote is neither moved nor replaced: reading and writing it fail with a note to update the extension.
- `model-runs/`: temporary folders of model calls, deleted when a call ends and cleared when the backend starts.
- Lock folders (`*.lock`, and the briefer `*.lock.guard`) that exist only while a file is written. A lock names its holder, which refreshes it every 0.5 seconds; one left by a process that died is taken over once it has gone 10 seconds without a refresh and then 1.5 seconds unchanged, by one waiter at a time, and a holder only ever removes its own lock.

### Uninstall

1. First, in **Second Brain → Settings → Agent integration**, select **Remove** for Claude Code and for Codex, then **Apply**. Uninstalling the extension does not touch `~/.claude/settings.json` or `~/.codex/AGENTS.md`: without this step the hook and the section stay there. Once the extension is uninstalled or turned off, the `mainline hook` and `mainline show` they run say and record nothing; the other `mainline` commands still read and write the data folder.
2. Then uninstall the extension in codexhost.
3. codexhost (up to 0.25.1 at least) keeps the data folder `~/.codexhost/host-extension-data/second-brain/` when it uninstalls the extension. It holds the mainlines and each conversation's latest message (`state.json`), the PR index with the first requests of conversations (`refs.json`), the saved passages, the files sent along with child conversations, the copies of your configuration made before the integration changed it (`backups/`, which can hold credentials), the log and the `mainline` command; the full list is above. Delete the folder by hand when you no longer need it.

### Load on codexhost

- Conversation titles and states come from one shared list of the 50 most recently updated conversations, asked for at most every 20 seconds, instead of reading each conversation. Only the conversation open on screen (at most every 15 seconds), conversations the list says are running (every minute) and conversations a page shows that are not on the list (every 5 minutes) are read on their own, two at a time; a read that fails waits a minute, then twice as long each time, up to 15 minutes. While Codex Desktop is in front, the delegation tree it reports comes first.
- Pages load all their data again only when something they show changed; the overview does not poll while hidden, and looks up PR states only while the **PRs and issues** tab is on screen.
- codexhost takes at most 2 MB per answer, and the backend's answers stay at 1.5 MB at most: past 1 MB, a snapshot cuts the latest requests short, then sends the conversations needed least (finished, then the oldest) as outlines (title, status, current milestone and progress), and the overview reads one in full when it is opened; saved passages come a page at a time, and PRs and issues newest first, saying how many did not fit.
- codexhost gives each call 10 seconds: opening a child conversation, **Summarize now** and starting the backfill wait at most 8 seconds, and what is not done goes on in the background. When the extension stops, every request to codexhost and `gh` under way is cut off, and it ends within a second.
- Diagnostics are off. To turn them on, set `localStorage["codexhost-mainline:debug"] = "1"` in the developer console of Desktop or Web.

### Reporting a problem

- The backend's log is `backend.log` in the data folder (the one before is `backend.log.1`). It records what the backend did: starting (with the extension's version, Node's version and the platform), installing or removing the integration, each model call (model, reason, short conversation id, time taken and outcome), the PRs and issues with GitHub activity (repository and number), the short ids of conversations it could not read, and why something failed. It holds no conversation text; your home folder is written as `~` and your user name in a path as `<user>`, but repository names are written as they are, so read it through before you post it.
- When the capsule, the hover card or the **★ Save** button sits in the wrong place, or the open conversation is not recognized, turn diagnostics on: run `localStorage["codexhost-mainline:debug"] = "1"` in the developer console of Desktop or Web, then make it happen again. That surface then writes what it sees of the page (the open conversation's short id, how many sidebar rows, where the header and the capsule are, and the like) to `backend.log`. Run `localStorage.removeItem("codexhost-mainline:debug")` to turn it off.

### Known limits

- Backend requests do not tell a remote codexhost Web session from a local one: anyone holding a codexhost Web session can do what the overview and the hover card can.
- The Claude Code hook also runs in nested Claude runs that inherit a codexhost conversation's environment (for example when an agent in the conversation runs `claude` itself), and records their messages as that conversation's latest message.
- After Claude Code compacts the context, the full mainline text comes back only with the refresh after 30 messages, a new session, or after 12 hours.
- The extension waits at most 20 seconds for codexhost to answer a request for a child conversation; a child that opens after that is not linked to its spin-off, and selecting it again may open a second one.
- Tested on macOS only; Windows and Linux are not verified.
- The hover card opens with a mouse only: the keyboard cannot open it, and neither can a touch screen, which has no hover. With the capsule off by default, someone on the keyboard alone or on a phone sees nothing of the mainline in a conversation; turn the capsule on in the settings (it opens from the keyboard), or use the Second Brain page.

## Develop

```sh
npm ci
npm run check     # type check, tests and build
npm run package   # dist/second-brain.zip
```

The built entries (`desktop.js`, `web/`, `page/`, `backend/`, `bin/`) are committed so codexhost can install straight from the repository (GitHub's source archive of a branch) as well as from `dist/second-brain.zip`, which also carries the license texts (`LICENSE` and `COPYING.txt`). codexhost takes only some file names in a package (a known suffix such as `.js`, `.md` or `.txt`, or names such as `LICENSE`) and refuses the whole package for any other; `test/package.test.ts` checks the zip and every file git tracks against codexhost's rules. The test run sets `MAINLINE_NO_MODEL=1`, which refuses every model call before any tool is looked for or started, and counts none; it is a switch for tests and development runs and does not reach the installed backend, which codexhost starts without your environment. What changed in each version is in [CHANGELOG.md](CHANGELOG.md). See [CONTRIBUTING.md](CONTRIBUTING.md) and, for security problems, [SECURITY.md](SECURITY.md).

## License

[LGPL-3.0-only](LICENSE), the same as codexhost. The LGPL-3.0 is a set of additional permissions on top of the GNU GPL-3.0, whose full text is in [COPYING.txt](COPYING.txt); the package carries both.

本插件以 [LGPL-3.0-only](LICENSE) 授权，与 codexhost 相同。LGPL-3.0 是在 GNU GPL-3.0 之上附加的许可，GPL-3.0 的全文在 [COPYING.txt](COPYING.txt)；两个文件都随安装包发布。
