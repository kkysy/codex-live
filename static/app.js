import { renderMarkdown } from "/markdown.js";

const $ = (s) => document.querySelector(s);
const messagesEl = $("#messages");
const input = $("#input");
const btnSend = $("#btnSend");
const btnStop = $("#btnStop");
const btnNew = $("#btnNew");
const btnNewLabel = $("#btnNewLabel");
const btnTheme = $("#btnTheme");
const btnAddProject = $("#btnAddProject");
const projectListEl = $("#projectList");
const threadListEl = $("#threadList");
const connDot = $("#connDot");
const connText = $("#connText");
const turnMeta = $("#turnMeta");
const cwdLabel = $("#cwdLabel");
const sideThread = $("#sideThread");
const permLabel = $("#permLabel");
const modelTag = $("#modelTag");

const state = {
  items: new Map(),
  order: [],
  busy: false,
  projects: [],       // [{path, name}]
  threads: [],        // [{id, title, project, cwd, updated, current}]
  selectedProject: null,  // 新对话的目标项目
};

/* ---------- 主题 ---------- */
const savedTheme = localStorage.getItem("cc-theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
btnTheme.addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = cur;
  localStorage.setItem("cc-theme", cur);
});

/* ---------- 渲染 ---------- */
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function escapeText(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function hideHero() {
  const hero = $("#hero");
  if (hero) hero.remove();
}

function partsOf(m) {
  // parts：按到达顺序的分段；旧快照（text + 尾部分类列表）就地转换
  if (m.parts && m.parts.length) return m.parts;
  const ps = [];
  if (m.text) ps.push({ type: "text", text: m.text });
  (m.thoughts || []).forEach((t) => ps.push({ type: "thought", text: t }));
  (m.searches || []).forEach((q) => ps.push({ type: "search", query: q }));
  (m.commands || []).forEach((c) => ps.push({ type: "command", text: c }));
  m.parts = ps;
  return ps;
}

function errorNode(m) {
  // 时间线条目（role=error）与客户端错误兜底共用；resolved = 该轮已正常收尾（重连成功）
  const box = el("div", "err");
  if (m.resolved) box.classList.add("resolved");
  const prefix = m.resolved ? "✓ " : (m.willRetry ? "⟳ " : "⚠ ");
  box.appendChild(el("div", "err-head", escapeText(prefix + (m.message || "未知错误"))));
  if (m.additionalDetails) {
    const d = el("div", "err-detail");
    d.textContent = m.additionalDetails;
    box.appendChild(d);
  }
  if (m.ts) box.appendChild(el("div", "err-ts", "· " + escapeText(m.ts)));
  return box;
}

function renderMsg(m) {
  let node = m._node;
  if (!node) {
    hideHero();
    node = el("div", `msg ${m.role}`);
    m._node = node;
    // 错误属于其 turnId 那轮的「尝试边界」：若该轮 assistant 消息已在渲染（流式中途断线），
    // 把错误节点插到它前面 —— 消息1 - 报错 - 消息2，而不是 append 到末尾沉底
    const anchor = (m.role === "error" && m.turnId) ? state.items.get(m.turnId) : null;
    const ref = anchor && anchor._node;
    if (ref && ref.parentNode) ref.parentNode.insertBefore(node, ref);
    else messagesEl.appendChild(node);
  }
  if (m.role === "user") {
    node.innerHTML = "";
    node.appendChild(el("div", "bubble"));
    node.firstChild.textContent = m.text;
    return node;
  }
  if (m.role === "error") {
    node.innerHTML = "";
    node.appendChild(errorNode(m));
    return node;
  }
  node.classList.toggle("streaming", !!m.streaming);
  node.innerHTML = "";
  node.appendChild(el("div", "who", "ChatGPT"));
  const body = el("div", "body");
  const parts = partsOf(m);
  if (!parts.length && m.streaming) {
    body.classList.add("empty");
    body.innerHTML = '<span class="thinking">正在思考…</span>';
  } else {
    // 按真实到达顺序渲染；连续的思考段合并进同一个 details
    const searchSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>`;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.type === "text") {
        const sec = el("div", "md-sec");
        sec.innerHTML = renderMarkdown(p.text || "");
        body.appendChild(sec);
      } else if (p.type === "thought") {
        const det = el("details", "thoughts");
        let n = i, cnt = 0;
        while (n < parts.length && parts[n].type === "thought") { cnt++; n++; }
        det.appendChild(el("summary", null, `💭 思考过程 (${cnt})`));
        for (let k = i; k < n; k++) {
          const t = el("div", "t-item");
          t.textContent = parts[k].text;
          det.appendChild(t);
        }
        body.appendChild(det);
        i = n - 1;
      } else if (p.type === "search") {
        const chips = el("div", "chips");
        chips.appendChild(el("span", "chip", `${searchSvg} ${escapeText(p.query || "")}`));
        body.appendChild(chips);
      } else if (p.type === "command") {
        // 工具调用/命令：默认折叠为单行摘要，点击展开完整内容
        const full = String(p.text || "");
        const firstLine = (full.split("\n")[0] || "").trim();
        const det = el("details", "cmd");
        const sum = el("summary", null, `⚙ ${escapeText(firstLine) || "命令"}`);
        det.appendChild(sum);
        const pre = el("pre", "cmd-full");
        pre.textContent = full;
        det.appendChild(pre);
        body.appendChild(det);
      }
    }
  }
  node.appendChild(body);
  return node;
}

const FOLDER_CLOSED = `<svg class="p-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>`;
const FOLDER_OPEN = `<svg class="p-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H6.5a2 2 0 0 0-1.9 1.4L3 17Z" /><path d="M3 17 5.6 10.7A2 2 0 0 1 7.5 9.4h12.1a1.5 1.5 0 0 1 1.4 2l-2 6.2a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-2Z" /></svg>`;

function threadRow(t, indent) {
  const b = el("button", "side-item" + (t.current ? " active" : ""));
  const title = el("span", "t-title");
  title.textContent = (indent ? "└ " : "") + t.title;
  title.title = t.title;
  const del = el("span", "t-del");
  del.textContent = "✕";
  del.title = "删除此会话";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    if (confirm(`删除会话「${t.title}」？\n将从本地和桌面 App 数据库中一并删除，不可恢复。`)) deleteThread(t.id);
  });
  b.appendChild(title);
  b.appendChild(del);
  b.addEventListener("click", () => openThread(t.id));
  return b;
}

function renderSidebar() {
  // 项目行：点击=选中为新对话目标；选中时展开该项目下的会话
  projectListEl.innerHTML = "";
  state.projects.forEach((p) => {
    const sel = state.selectedProject === p.path;
    const b = el("button", "side-item project" + (sel ? " selected" : ""));
    b.title = p.path;
    b.appendChild(el("span", "p-ico-wrap", (sel ? FOLDER_OPEN : FOLDER_CLOSED)));
    const nm = el("span", "t-title");
    nm.textContent = p.name;
    b.appendChild(nm);
    b.addEventListener("click", () => {
      state.selectedProject = state.selectedProject === p.path ? null : p.path;
      renderSidebar();
      updateNewLabel();
    });
    projectListEl.appendChild(b);
    if (state.selectedProject === p.path) {
      state.threads.filter((t) => t.project === p.path).forEach((t) => {
        projectListEl.appendChild(threadRow(t, true));
      });
    }
  });

  // 独立会话（无项目）
  threadListEl.innerHTML = "";
  state.threads.filter((t) => !t.project).forEach((t) => {
    threadListEl.appendChild(threadRow(t, false));
  });
}

async function deleteThread(tid) {
  const r = await fetch("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" },
                                         body: JSON.stringify({ threadId: tid }) });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    alert(d.message || "删除失败");
  }
}

function updateNewLabel() {
  const p = state.projects.find((x) => x.path === state.selectedProject);
  btnNewLabel.textContent = p ? `新对话（${p.name}）` : "新对话";
}

function updateHeader(d) {
  permLabel.textContent = d.sandboxLabel || d.sandbox || "—";
  const model = (d.model || "—").replace(/^gpt-/i, "GPT-")
    .replace(/-luna/i, " Luna").replace(/-terra/i, " Terra").replace(/-sol/i, " Sol");
  const effort = d.effort ? { low: "低", medium: "中", high: "高", xhigh: "超高" }[d.effort] || d.effort : "";
  modelTag.textContent = `${model}${effort ? " " + effort : ""}`;
  cwdLabel.textContent = d.cwd || "";
  sideThread.textContent = (d.threadId || "—").slice(0, 8);
}

function applySnapshot(d) {
  // 重置消息区
  state.items.clear();
  state.order.length = 0;
  messagesEl.innerHTML = '<div class="hero" id="hero"><div class="hero-mark">⌘</div><h1>我们要聊点什么?</h1></div>';
  state.busy = d.busy;
  state.projects = d.projects || [];
  state.threads = d.threads || [];
  if (!state.selectedProject && state.projects.length) {
    /* 不自动选中，保持"无项目"为默认 */
  }
  (d.messages || []).forEach((m) => {
    state.items.set(m.id, m);
    state.order.push(m.id);
    renderMsg(m);
  });
  updateHeader(d);
  updateNewLabel();
  renderSidebar();
  updateBusyUI();
  forceScrollBottom();
}

/* ---------- 底部跟随（参考 Skilldock：流式时跟随到底，用户上滚即解除） ---------- */
const BOTTOM_THRESHOLD = 64;
let stickToBottom = true;

function isNearBottom() {
  const sc = $("#scroller");
  return sc.scrollHeight - sc.scrollTop - sc.clientHeight <= BOTTOM_THRESHOLD;
}

function scrollToBottom(behavior = "auto") {
  const sc = $("#scroller");
  sc.scrollTo({ top: sc.scrollHeight, behavior });
}

function maybeScroll() {
  if (stickToBottom) scrollToBottom();
}

function forceScrollBottom() {
  stickToBottom = true;
  scrollToBottom();
}

function initScrollFollow() {
  const sc = $("#scroller");
  sc.addEventListener("scroll", () => {
    stickToBottom = isNearBottom();
    const toBottom = $("#toBottom");
    if (toBottom) toBottom.classList.toggle("hidden", stickToBottom);
  });
  $("#toBottom").addEventListener("click", () => {
    forceScrollBottom();
    scrollToBottom("smooth");
  });
}

function updateBusyUI() {
  btnStop.classList.toggle("hidden", !state.busy);
  btnSend.classList.toggle("hidden", state.busy);
  btnSend.disabled = state.busy || !input.value.trim();
}

/* ---------- SSE ---------- */
if (new URLSearchParams(location.search).has("nosse")) {
  // 调试模式：只拉一次状态，不建长连接（供无头测试/排障用）
  fetch("/api/state").then((r) => r.json()).then((d) => applySnapshot(d)).catch(() => {});
} else {
  const es = new EventSource("/api/events");
  es.onopen = () => {
    connDot.className = "dot on";
    connText.textContent = "实时已连接";
  };
  es.onerror = () => {
    connDot.className = "dot off";
    connText.textContent = "重连中…";
  };
  es.onmessage = (e) => {
    if (!e.data) return;
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    handle(ev);
  };
}

function handle(ev) {
  switch (ev.type) {
    case "snapshot":
      applySnapshot(ev);
      return;
    case "item": {
      const m = ev.item;
      const known = state.items.get(m.id);
      if (known && known._node) m._node = known._node;  // 保留 DOM 引用，否则会重复渲染一个新节点
      state.items.set(m.id, m);
      if (!known) state.order.push(m.id);
      renderMsg(m);
      if (m.role === "user") forceScrollBottom();   // 用户自己发消息：总是跟到最新
      else maybeScroll();
      break;
    }
    case "delta": {
      let m = state.items.get(ev.itemId);
      if (!m) {
        m = { id: ev.itemId, role: "assistant", parts: [], streaming: true, ts: "" };
        state.items.set(m.id, m);
        state.order.push(m.id);
      }
      const ps = partsOf(m);
      if (ps.length && ps[ps.length - 1].type === "text") ps[ps.length - 1].text += ev.delta;
      else ps.push({ type: "text", text: ev.delta });
      renderMsg(m);
      maybeScroll();
      break;
    }
    case "remove": {
      const m = state.items.get(ev.id);
      state.items.delete(ev.id);
      state.order = state.order.filter((x) => x !== ev.id);
      if (m && m._node) m._node.remove();
      break;
    }
    case "status":
      state.busy = ev.busy;
      updateBusyUI();
      break;
    case "turn_completed":
      state.busy = false;
      updateBusyUI();
      if (ev.usage && (ev.usage.input || ev.usage.output))
        turnMeta.textContent = `tokens: ${ev.usage.input ?? "?"} in / ${ev.usage.output ?? "?"} out`;
      refreshMeta();  // 模型/标题可能已更新
      maybeScroll();
      notifyTurnDone();
      break;
    case "thread": {
      const t = state.threads.find((x) => x.id === ev.threadId);
      if (t) t.title = ev.title || t.title;
      renderSidebar();
      break;
    }
    case "error": {
      // 客户端侧错误兜底（如发送失败）；服务端错误已作为 role=error 时间线条目进入正常渲染
      hideHero();
      messagesEl.appendChild(errorNode({ message: ev.message }));
      maybeScroll();
      break;
    }
    case "notice": {
      hideHero();
      const n = el("div", "notice");
      n.textContent = "· " + ev.message;
      messagesEl.appendChild(n);
      break;
    }
  }
}

async function refreshMeta() {
  try {
    const d = await (await fetch("/api/state")).json();
    updateHeader(d);
    state.threads = d.threads || [];
    state.projects = d.projects || state.projects;
    renderSidebar();
  } catch { /* 忽略 */ }
}

/* ---------- 完成提醒（标签页在后台时改标题提示） ---------- */
let titleTimer = null;
function notifyTurnDone() {
  if (!document.hidden) { document.title = "Codex Live"; return; }
  if (titleTimer) return;
  let on = false;
  titleTimer = setInterval(() => {
    on = !on;
    document.title = on ? "✅ GPT 已回复 — Codex Live" : "Codex Live";
  }, 1200);
  const restore = () => {
    clearInterval(titleTimer);
    titleTimer = null;
    document.title = "Codex Live";
    document.removeEventListener("visibilitychange", restore);
  };
  document.addEventListener("visibilitychange", restore);
}

/* ---------- 动作 ---------- */
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
  updateBusyUI();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
btnSend.addEventListener("click", send);
btnStop.addEventListener("click", () => fetch("/api/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
btnNew.addEventListener("click", () =>
  fetch("/api/new", { method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ project: state.selectedProject }) }));
btnAddProject.addEventListener("click", async () => {
  const path = prompt("输入项目文件夹的完整路径（如 E:\\HighEV_sampling）：");
  if (!path) return;
  await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" },
                                 body: JSON.stringify({ path }) });
});

async function openThread(tid) {
  const r = await fetch("/api/open", { method: "POST", headers: { "Content-Type": "application/json" },
                                       body: JSON.stringify({ threadId: tid }) });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    alert(d.message || "切换失败");
  }
}

async function send() {
  const text = input.value.trim();
  if (!text || state.busy) return;
  input.value = "";
  input.style.height = "auto";
  forceScrollBottom();
  updateBusyUI();
  const r = await fetch("/api/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    handle({ type: "error", message: d.message || "发送失败" });
    state.busy = false;
    updateBusyUI();
  }
}

/* ---------- 侧边栏折叠与调宽 ---------- */
function initSidebar() {
  const app = $("#app");
  const side = $("#sidebar");
  const toggle = $("#btnSide");
  const resizer = $("#sideResizer");

  const savedW = parseInt(localStorage.getItem("cc-sidebar-w"), 10);
  if (savedW >= 170 && savedW <= 460) side.style.width = savedW + "px";
  if (localStorage.getItem("cc-sidebar-collapsed") === "1") app.classList.add("side-collapsed");

  toggle.addEventListener("click", () => {
    const collapsed = app.classList.toggle("side-collapsed");
    localStorage.setItem("cc-sidebar-collapsed", collapsed ? "1" : "0");
  });

  let dragging = false;
  resizer.addEventListener("pointerdown", (e) => {
    if (app.classList.contains("side-collapsed")) return;
    dragging = true;
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
  });
  resizer.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const w = Math.min(460, Math.max(170, e.clientX));
    side.style.width = w + "px";
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
    localStorage.setItem("cc-sidebar-w", String(parseInt(side.style.width, 10) || 240));
  };
  resizer.addEventListener("pointerup", endDrag);
  resizer.addEventListener("pointercancel", endDrag);
}

updateBusyUI();
initScrollFollow();
initSidebar();
