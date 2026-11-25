# 更新记录 / Changelog

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
