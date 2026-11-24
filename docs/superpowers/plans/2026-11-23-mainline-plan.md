# 主线任务插件实现计划

> 0.10 起插件改名为「第二大脑 / Second Brain」（id `second-brain`，总览页也叫「第二大脑」）；本计划是 v1 的实现计划，保留当时的名字。

依据：[设计文档](../specs/2026-11-23-mainline-design.md)。参照：`~/Code/codexhost-sidebar-thread-tree`（构建、打包、CI 模式），codex-host `origin/main` 的扩展宿主源码（API 以源码为准）。

## 宿主约束（已核实）

- 后台：`activate(ctx)` 只能在激活时 `ctx.handle` 注册方法；单次调用 10 秒超时；返回值经过严格 JSON 检查，含 `undefined` 的字段会报错，返回前必须清洗；子进程没有环境变量，`stdio` 被忽略，诊断写日志文件。入口必须是单个打包文件。
- Desktop 入口：经典脚本，`define({ activate })`；`dom.mount(node, parent)`；`navigate.openThread` 只接受本机 Thread。
- Web 入口：ESM `activate(api)`；`dom.mount(HTMLElement | region)` 返回 `{ container, dispose }`。
- 样式：Shadow DOM，加 `adoptedStyleSheets`（回退到 `<style>`），与宿主挂件做法一致。
- 当前窗口：Desktop 看 `[data-above-composer-conversation-id]` 与 `data-app-action-sidebar-thread-active`；Web 看 `[data-row-key="session:<id>"][aria-current="page"]`，Web 的 sessionId 等于 Thread ID。
- 本机接口：`POST /v1/thread/read { threadId }`、`POST /v1/thread/list { parentThreadId }`，凭据在 `cli-credentials.json`（Bearer）。

## 阶段

| # | 产出 | 文件 | 验证 |
| --- | --- | --- | --- |
| 0 | 工程骨架：package.json、tsconfig、vitest、构建与打包脚本、manifest v2 | `package.json` `scripts/build.mjs` `manifest.json` | `npm run build` 产出全部入口 |
| 1 | 核心模型与纯函数操作、卡片视图、协议文本、界面文案 | `src/core/*` | 单元测试 |
| 2 | 文件存储（锁、原子写、损坏恢复）与命令行、Claude hook | `src/node/store.ts` `src/cli/main.ts` | 临时目录端到端、并发写测试 |
| 3 | 后台：快照、编辑、对话信息（Desktop 上报和本机接口）、委派继承、协作安装器、日志 | `src/backend/*` | 假 ctx 和本地 HTTP 测试服务器；临时 HOME 测安装器 |
| 4 | 共用胶囊与卡片、轮询控制器、主题、拖动；Desktop 入口 | `src/ui/*` `src/desktop/index.ts` | jsdom 渲染与 DOM 夹具识别测试 |
| 5 | Web 入口 | `src/web/index.ts` | DOM 夹具识别和跳转测试 |
| 6 | 主线总览页 | `src/page/*` | 假 api 渲染测试 |
| 7 | 图标、README、打包检查 | `assets/icon.png` `README*.md` | `npm run check`、`npm run package` |
| 8 | 实机验证：装进用户的 codexhost，检查诊断、在本会话用命令行建主线、截图确认 | — | 诊断为 running，胶囊可见 |

不做：推送 GitHub、发布 Release、向插件市场投稿（等用户确认）。
