# Contributing

**English** · [简体中文](#参与贡献)

Thanks for helping improve Second Brain. Bug reports and pull requests are both welcome.

## Set up

You need Node.js 22 or later (CI runs on 24).

```sh
npm ci
npm run check        # type check, tests and build
npm run package      # dist/second-brain.zip
npm run screenshots  # the README images in docs/images (needs Google Chrome)
```

- `src/` holds the extension and `test/` its tests.
- `desktop.js`, `web/`, `page/`, `backend/` and `bin/` are built from `src/`. Commit them with your change; CI checks that they match the source.
- The tests never call a model: the test run sets `MAINLINE_NO_MODEL=1`, and the tests of the model runner use stand-in tools. Keep it that way.
- The README images in `docs/images/` are drawn by `npm run screenshots` from the extension's own interface code with the made-up demo data of `scripts/screenshots/`; the diagrams are hand-written SVG files in `docs/images/` too. After a visible change, draw them again and look at each one before you commit it. Images only ever show made-up data: never take a screenshot of your own codexhost.

## Try it in codexhost

Run `npm run package`, then choose `dist/second-brain.zip` under **Plugins → Import plugin → Local .zip**. It replaces the installed copy.

## Keep the extension safe to run

- Send a model only what the README says, with secrets masked first, and count every call.
- The agent integration changes only its own hook in `~/.claude/settings.json` and its own marked section in `~/.codex/AGENTS.md`, and shows the exact change first. Nothing else outside the extension's data folder is written.
- Keep every backend call inside its own budget, under codexhost's limits of 10 seconds and 2 MiB: an answer within 8 seconds, of at most 1.5 MiB.
- Check light and dark themes, both languages, the keyboard, and motion under Reduce Motion.
- Whatever cannot be undone takes two clicks (the existing confirm button, which screen readers hear); whatever can be undone takes one.

## Open a pull request

- Keep one topic per pull request, and say what changed and why.
- Describe how you verified it, with screenshots or a short recording for visible changes.
- Leave `version` in `manifest.json` unchanged; it is raised when a release is published.

Contributions are licensed under [LGPL-3.0-only](LICENSE) (with the GPL-3.0 text it builds on in [COPYING.txt](COPYING.txt)), like the rest of the project.

---

# 参与贡献

[English](#contributing) · **简体中文**

感谢你帮助改进「第二大脑」。欢迎提交问题报告，也欢迎直接提 PR。

## 准备环境

需要 Node.js 22 或更高版本（CI 用 24）。

```sh
npm ci
npm run check        # 类型检查、测试和构建
npm run package      # 生成 dist/second-brain.zip
npm run screenshots  # 画 README 里的图（docs/images），需要 Google Chrome
```

- `src/` 是插件源码，`test/` 是对应的测试。
- `desktop.js`、`web/`、`page/`、`backend/` 和 `bin/` 由 `src/` 构建而来，请随改动一起提交；CI 会检查它们与源码一致。
- 测试从不调用模型：测试运行时设置了 `MAINLINE_NO_MODEL=1`，模型调用本身的测试用替身工具。请保持这一点。
- README 里的图（`docs/images/`）由 `npm run screenshots` 用插件自己的界面代码和 `scripts/screenshots/` 里虚构的示例数据画出来，示意图是 `docs/images/` 里手写的 SVG。界面有变化时重新画一遍，提交前每张图都看一遍。图里只能是虚构的数据：不要截自己的 codexhost。

## 在 codexhost 中试用

运行 `npm run package`，再在「插件 → 导入插件 → 本地 .zip」选择 `dist/second-brain.zip`，它会替换已安装的版本。

## 让插件始终安全可用

- 发给模型的只能是 README 写明的内容，先遮掉密钥，每次调用都要计数。
- Agent 协作只改它自己在 `~/.claude/settings.json` 里的 hook 和 `~/.codex/AGENTS.md` 里带标记的一段，修改前先展示具体改动；插件数据目录以外的其他文件一律不写。
- 后台的每个调用都要守住自己的预算（codexhost 的上限是 10 秒和 2 MiB）：8 秒内答复，答复不超过 1.5 MiB。
- 浅色和深色主题、中英文、键盘操作都要检查，开启“减少动态效果”时不播放动效。
- 不能撤销的操作要连点两次（用现有的确认按钮，读屏能听到），能撤销的点一次。

## 提交 PR

- 一个 PR 只做一件事，写清改了什么、为什么。
- 说明你是怎样验证的；界面有变化时附截图或短录屏。
- 不要修改 `manifest.json` 的 `version`，发布新版本时统一升级。

贡献内容与本项目其他部分一样，以 [LGPL-3.0-only](LICENSE) 授权（它所依据的 GPL-3.0 全文见 [COPYING.txt](COPYING.txt)）。
