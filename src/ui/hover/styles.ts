/**
 * Styles of the sidebar hover card, the row badge, the bells and the summary of news with its list,
 * injected into their shadow root. The palette
 * repeats `.root` of src/ui/styles.css so the card and the capsule look alike (text at 4.5:1 or
 * more in both schemes); `data-scheme="dark"` comes from detectScheme().
 */
export const HOVER_CSS = `
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
  content: "⑂ ";
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

/* "🔔 N" at the top of the sidebar: news whose conversation has no row in sight. */
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
