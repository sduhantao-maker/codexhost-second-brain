# 更新记录 / Changelog

## 0.10.3

修了 PR 与 Issue 的 🔔 自己消失、或者根本看不到的问题。以前打开（或切换到）提出它的对话就算看过了：可主线胶囊默认关闭，打开对话时看不到任何新动态；同时开着两个停在不同对话上的 Web 页面（codexhost 窗口和浏览器标签页）时，每次轮询都算一次切换，🔔 几秒内就被清掉。现在 🔔 只在你处理它时消失：🔔 或悬停卡片里的新动态显示着时点这个对话的侧栏行，在卡片里点「知道了」，在下面说的列表里点「打开对话」或「知道了」，或在「PR 与 Issue」页签里点「跳转」。后台按窗口分别记每个窗口打开的对话，几个窗口停在不同对话上不再算切换。🔔 现在要等你处理才消失，所以同时挂 🔔 的 PR 和 issue 从最多 10 个放宽到 50 个，免得还没处理的被挤掉。

对话在侧栏里没有看得见的行时（在收起的分组里、滚出了列表或没有列出），它的 🔔 以前画不出来。现在侧栏顶部显示「🔔 N」，N 是这样的新动态有几条，放在不遮住侧栏文字和按钮的地方；点它列出这些新动态（仓库和编号、标题、发生了什么、什么时候、来自哪个对话），每条可以「打开对话」或「知道了」。看得见的行照旧挂自己的 🔔。

有 Codex Desktop 或 codexhost 的窗口开着时，GitHub 通知改为每分钟读一次（原来每 3 分钟），窗口都关掉或隐藏 10 分钟后仍是每 10 分钟一次。README 原来说「最近 10 分钟用过插件界面时」，其实每个开着的窗口都让插件算在用，现在照实写明。

还修了一处：新版 Codex Desktop（在 26.1120 上确认）鼠标停在侧栏对话上时弹出的会话预览换了做法，预览本身是个没有大小的弹层，看得见的部分是里面单独定位的一块。插件认不出它，主线卡片没有让开，被预览盖住了一截。现在新旧两种预览都认得出，卡片照旧排在预览下面或旁边。

Fixed the 🔔 on news about PRs and issues going away by itself, or never showing. Opening (or switching to) the conversation a PR came from used to count as seeing its news, although the capsule is off by default and opening the conversation showed none of it; and with two Web pages open on different conversations (the codexhost window and a browser tab), every poll counted as a switch and cleared the bells within seconds. A 🔔 now goes away only when you act on it: select the conversation's sidebar row while its 🔔 or the news in its hover card shows, select Got it in the card, Open conversation or Got it in the list described below, or Go in the PRs and issues tab. The backend keeps the conversation open in each window apart, so windows on different conversations no longer count as switching. Since a 🔔 now waits for you, up to 50 PRs and issues carry one at a time (it was 10), so that none is pushed out before you get to it.

When a conversation with news had no row in sight in the sidebar (in a collapsed group, scrolled away, or not listed), its 🔔 could not be drawn. Now a 🔔 N at the top of the sidebar counts such news, placed where it covers none of the sidebar's text and buttons; select it to list that news (repository and number, title, what happened and when, the conversation it came from), each with Open conversation and Got it. Rows in sight keep their own 🔔.

GitHub notifications are now read every minute (it was every 3 minutes) while a Codex Desktop or codexhost window is open, and still every 10 minutes once all of them have been closed or hidden for 10 minutes. The README used to say "when its views were used in the last 10 minutes"; in fact every open window keeps the extension in use, and the README now says so.

Also fixed: newer Codex Desktop (seen in 26.1120) builds the conversation preview it shows when the pointer rests on a sidebar row differently: the preview itself is a popover with no size, and what shows is a child placed on its own. The extension did not recognize it, the hover card did not make room, and the preview covered part of the card. Both kinds of preview are recognized now, and the card goes under or beside the preview as before.

## 0.10.2

插件介绍和 README 开头加上一句「有限的注意力，迅速收回。」，末尾加上反馈渠道和 Star 邀请；插件市场列表里的简介也以这句开头。README 写明在 codexhost 0.26.0 上测试过。

修了一处：umask 为 077 时，安装或卸载 Agent 协作会把 `~/.claude/settings.json` 和 `~/.codex/AGENTS.md` 原有的权限收紧成只有自己能读写（比如 644 变成 600）。现在原有文件保持原来的权限；新建的文件仍按 umask。

The extension's details and the README now open with "Your attention is limited; get it back fast." and end with where to send feedback and an invitation to star the repository; the short description in the marketplace list starts with the same line. The README now says the extension is tested on codexhost 0.26.0.

One fix: with a umask of 077, installing or removing the agent integration narrowed the existing permissions of `~/.claude/settings.json` and `~/.codex/AGENTS.md` to owner-only (644 became 600, for example). An existing file now keeps its permissions; a new file still follows the umask.

## 0.10.1

插件介绍配上了图：插件页面和 README 里有侧栏悬停卡片、工作方式图、总览页和收藏回复的截图，图里的示例数据都是虚构的。README 中英文两节各有一套，`npm run screenshots` 可以重新生成。插件本身的功能没有变化。

The extension's details now show pictures: the sidebar hover card, how it works, the overview, and saving a reply; all example data in them is made up. The README carries the same images in Chinese and English, and `npm run screenshots` regenerates them. The extension itself works as before.

## 0.10.0

第一个公开版本。第二大脑记住每个对话在做什么、做到哪一步、哪段回复值得留下。

- 每个对话一条主线：回复结束后，小模型写出标题、标签、里程碑和状态；Agent 边做边记支线任务；你手动改过的保持不动。
- 鼠标停在侧栏的对话上就能看到主线和里程碑，还能从卡片开子对话，附带照片、文件或视频。主线胶囊可选。
- 「第二大脑」页面：对话、收藏、PR 与 Issue 和设置四个页签，可以用线索找对话；有人评审、合并或评论你经手的 PR 或 issue 时提醒你（经 gh，只读）。
- 收藏值得留下的回复，随时跳回原文。
- 可选的 Agent 协作：Claude Code 的一条 hook 和 Codex AGENTS.md 里的一段说明，修改前先给你看具体改动。
- 不能撤销的删除都要连点两次，能撤销的操作点一次。
- 开发中的旧版叫「主线任务」（`mainline`），改名后第一次启动会把它的数据复制过来，见 README。
- 已知限制：悬停卡片只能用鼠标，键盘和触屏都打不开；只在 macOS 上用 codexhost 0.25.1 测试过；后台分不出请求来自本机还是远程的 codexhost Web 会话。完整列表见 README。

The first public release. Second Brain remembers what each conversation is doing, how far it got, and which replies are worth keeping.

- One mainline per conversation: after each reply, a small model writes the title, tags, milestones and status; agents record tasks as they work; what you edit by hand stays.
- Rest the pointer on a conversation in the sidebar to see its mainline and milestones, and open a child conversation from that card, with photos, files or videos attached. The capsule over the conversation is optional.
- The Second Brain page: conversations, saved passages, PRs and issues, and settings, with a search that finds a conversation by a clue; an alert when someone reviews, merges or comments on a PR or issue you worked on (through gh, read only).
- Save the replies worth keeping, and go back to where they were said.
- An optional agent integration: one hook for Claude Code and one section in Codex's AGENTS.md, with the exact change shown first.
- Whatever cannot be undone takes two clicks; whatever can be undone takes one.
- The development version was called Mainline (`mainline`); the first start under the new name copies its data over, see the README.
- Known limits: the hover card opens with a mouse only, neither the keyboard nor a touch screen can open it; tested on macOS with codexhost 0.25.1 only; the backend cannot tell a local request from one of a remote codexhost Web session. The README lists them all.
