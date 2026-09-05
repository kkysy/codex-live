#!/usr/bin/env python3
"""Codex Live — 本地 ChatGPT 实时聊天桥

纯 Python 标准库实现：
  - HTTP 服务：托管 static/ 下的仿 Codex 界面
  - SSE (/api/events)：把 codex app-server 的事件实时推给浏览器
  - 桥接：spawn ~/codex-bin/codex.exe app-server（JSON-RPC over stdio），
    与桌面 App 同款协议/同款账号，会话写入 App 的线程数据库
  - 项目：与桌面 App 共享 project/list；可在项目内建对话、切换历史会话

运行: python server.py [端口]   （默认 8765，被占用则自动 +1）
"""
import json
import os
import queue
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
# codex CLI 可执行文件位置；不同安装方式可用环境变量 CODEX_BIN 覆盖
# （npm 安装通常在 ~/AppData/Roaming/npm/codex.cmd，或直接 `where codex` 查）
CODEX = Path(os.environ.get("CODEX_BIN") or Path.home() / "codex-bin" / "codex.exe")
LOCKS = Path.home() / ".codex" / "thread-writer-locks"
STATE_FILE = BASE / "state.json"

SANDBOX_LABELS = {
    "workspace-write": "工作区写入",
    "danger-full-access": "完全访问",
    "read-only": "只读",
}
SANDBOX_ALIASES = {
    "read-only": "read-only", "readonly": "read-only", "只读": "read-only",
    "workspace-write": "workspace-write", "workspacewrite": "workspace-write", "工作区写入": "workspace-write",
    "danger-full-access": "danger-full-access", "full-access": "danger-full-access",
    "完全访问": "danger-full-access", "完全": "danger-full-access",
}

def sandbox_api(mode: str):
    """把简写转成 app-server 的 SandboxPolicy 对象"""
    m = SANDBOX_ALIASES.get((mode or "").lower().strip(), (mode or "").lower().strip())
    if m == "read-only":
        return {"type": "readOnly"}
    if m == "danger-full-access":
        return {"type": "dangerFullAccess"}
    if m == "workspace-write":
        return {"type": "workspaceWrite"}
    return None


def now_s():
    return time.strftime("%H:%M:%S")


def read_sandbox_from_config():
    """从 ~/.codex/config.toml 读 sandbox_mode（实际生效的沙箱策略）"""
    cfg = Path.home() / ".codex" / "config.toml"
    try:
        for line in cfg.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line.startswith("sandbox_mode"):
                val = line.split("=", 1)[1].strip().strip('"').strip("'")
                return val
    except OSError:
        pass
    return "workspace-write"


class Bridge:
    """与 codex app-server 的常驻桥接"""

    def __init__(self):
        self.proc = None
        self.rpc_id = 0
        self.initialized = False
        self.pending = {}          # rpc_id -> queue.Queue
        self.thread_id = None
        self.busy = False
        self.clients = []          # SSE 订阅队列
        self.big_lock = threading.Lock()
        self.sandbox = read_sandbox_from_config()
        # state: {current, threads:{tid:{title,project,cwd,model,effort,messages,updated}}, projects:[..]}
        self.threads = {}
        self.projects = []
        self._load_state()
        self._start_proc()
        self._ensure_proc()
        self._load_projects()
        if not self.thread_id:
            self._open_thread()

    # ---------- 状态持久化 ----------
    def _load_state(self):
        if STATE_FILE.exists():
            try:
                d = json.loads(STATE_FILE.read_text(encoding="utf-8"))
                self.thread_id = d.get("current")
                self.threads = d.get("threads", {})
                self.projects = d.get("projects", [])
                for r in self.threads.values():
                    r["messages"] = [self._migrate_msg(m) for m in r.get("messages", [])]
            except Exception as e:
                print("[state] 读取失败:", e)

    @staticmethod
    def _migrate_msg(m):
        """旧格式（text + 三个尾部分类列表）→ 按 parts 分段；历史顺序无法还原，正文在前"""
        if m.get("role") != "assistant" or "parts" in m:
            return m
        parts = []
        if m.get("text"):
            parts.append({"type": "text", "text": m["text"]})
        for t in m.get("thoughts", []):
            parts.append({"type": "thought", "text": t})
        for q in m.get("searches", []):
            parts.append({"type": "search", "query": q})
        for c in m.get("commands", []):
            parts.append({"type": "command", "text": c})
        m["parts"] = parts
        return m

    def _save_state(self):
        try:
            STATE_FILE.write_text(json.dumps(
                {"current": self.thread_id, "threads": self.threads, "projects": self.projects},
                ensure_ascii=False, indent=1), encoding="utf-8")
        except Exception as e:
            print("[state] 写入失败:", e)

    def _reg(self, tid):
        """线程注册表条目（无则建）"""
        if tid not in self.threads:
            self.threads[tid] = {"title": "新对话", "project": None, "cwd": None,
                                 "model": None, "effort": None, "messages": [],
                                 "updated": time.time()}
        return self.threads[tid]

    # ---------- SSE ----------
    def subscribe(self):
        q = queue.Queue(maxsize=2000)
        self.clients.append(q)
        return q

    def unsubscribe(self, q):
        if q in self.clients:
            self.clients.remove(q)

    def emit(self, ev: dict):
        for q in list(self.clients):
            try:
                q.put_nowait(ev)
            except queue.Full:
                pass

    def last_text(self):
        """轻量监控端点：只返回最后一条 assistant 消息的正文 text 段，
        命令/思考段只给计数不给内容（命令文本单轮可达 3 万字符，全量拉取浪费 token）。"""
        reg = self._reg(self.thread_id) if self.thread_id else {}
        assistants = [m for m in reg.get("messages", []) if m.get("role") == "assistant"]
        if not assistants:
            return {"ok": True, "text": "", "n_commands": 0, "n_thoughts": 0,
                    "streaming": False, "busy": self.busy, "threadId": self.thread_id}
        m = self._migrate_msg(assistants[-1])
        parts = m.get("parts", [])
        return {
            "ok": True,
            "text": "\n".join(p.get("text", "") for p in parts if p.get("type") == "text"),
            "n_commands": sum(1 for p in parts if p.get("type") == "command"),
            "n_thoughts": sum(1 for p in parts if p.get("type") == "thought"),
            "streaming": bool(m.get("streaming")),
            "busy": self.busy,
            "threadId": self.thread_id,
        }

    def snapshot(self):
        reg = self._reg(self.thread_id) if self.thread_id else {}
        sandbox = reg.get("sandbox") or self.sandbox
        return {
            "threadId": self.thread_id,
            "title": reg.get("title", "新对话"),
            "busy": self.busy,
            "model": reg.get("model") or "gpt-5.6-luna",
            "effort": reg.get("effort") or "high",
            "sandbox": sandbox,
            "sandboxLabel": SANDBOX_LABELS.get(sandbox, sandbox),
            "cwd": reg.get("cwd"),
            "messages": [self._public(m) for m in reg.get("messages", [])],
            "projects": self.project_list(),
            "threads": self.thread_list(),
        }

    def project_list(self):
        """项目 = app-server project/list（与桌面App同源） + 手动添加"""
        try:
            res = self._rpc("project/list", {"limit": 100}, timeout=15)
            rows = res.get("data") or res.get("projects") or []
            for p in rows:
                roots = p.get("roots") or []
                path = p.get("path") or (roots[0].get("path") if roots else "")
                if path and path not in self.project_paths_cached():
                    self.projects.append(path)
        except Exception:
            pass
        return [{"path": p, "name": Path(p).name or p} for p in self.projects]

    def project_paths_cached(self):
        return list(self.projects)

    def thread_list(self):
        items = []
        for tid, r in self.threads.items():
            items.append({"id": tid, "title": r.get("title", "新对话"),
                          "project": r.get("project"), "cwd": r.get("cwd"),
                          "updated": r.get("updated", 0), "current": tid == self.thread_id})
        items.sort(key=lambda x: x["updated"], reverse=True)
        return items

    # ---------- app-server 进程 ----------
    def _start_proc(self):
        self.proc = subprocess.Popen(
            [str(CODEX), "app-server"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, cwd=str(BASE),
            text=True, encoding="utf-8", errors="replace", bufsize=1)
        threading.Thread(target=self._reader, daemon=True).start()

    def _rpc(self, method, params, timeout=30):
        self.rpc_id += 1
        rid = self.rpc_id
        q = self.pending[rid] = queue.Queue()
        msg = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        self.proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        try:
            res = q.get(timeout=timeout)
        finally:
            self.pending.pop(rid, None)
        if "error" in res:
            raise RuntimeError(res["error"].get("message", str(res["error"])))
        return res.get("result", {})

    def _reader(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" in d and d["id"] in self.pending:
                self.pending[d["id"]].put(d)
            elif "method" in d:
                try:
                    self._on_notification(d["method"], d.get("params") or {})
                except Exception as e:
                    print("[notify]", d["method"], "处理出错:", e)

    def _ensure_proc(self):
        if self.proc is None or self.proc.poll() is not None:
            print("[bridge] app-server 进程退出，重启")
            self._start_proc()
            self.initialized = False
        if not self.initialized:
            self._rpc("initialize", {"clientInfo": {"name": "codex-live", "title": "Codex Live", "version": "1.1.0"},
                                     "capabilities": {"experimentalApi": True}})
            self.initialized = True
            if self.thread_id:
                try:
                    self._resume(self.thread_id)
                except Exception as e:
                    print("[bridge] 续接失败，开新线程:", e)
                    self.thread_id = None
                    self._open_thread()

    def _load_projects(self):
        try:
            res = self._rpc("project/list", {"limit": 100}, timeout=15)
            for p in res.get("projects", []):
                path = p.get("path") or p.get("root") or ""
                if path and path not in self.projects:
                    self.projects.append(path)
            self._save_state()
        except Exception as e:
            print("[projects] project/list 不可用（用手动列表）:", e)

    # ---------- 线程管理 ----------
    def _resume(self, tid):
        try:
            self._rpc("thread/resume", {"threadId": tid})
        except RuntimeError as e:
            if "active writer" not in str(e):
                raise
            lock = LOCKS / f"{tid}.lock"
            print("[bridge] 线程被占用，清锁重试:", lock)
            lock.unlink(missing_ok=True)
            self._rpc("thread/resume", {"threadId": tid})
        self.thread_id = tid
        self._reg(tid)["updated"] = time.time()
        self._save_state()
        print("[bridge] 切换到线程", tid)

    def _open_thread(self, project=None, model=None):
        params = {"approvalPolicy": "never"}
        cwd = project
        if cwd:
            params["cwd"] = cwd
        if model:
            params["model"] = model
        res = self._rpc("thread/start", params)
        th = res.get("thread") or {}
        tid = th.get("id") or res.get("threadId")
        if not tid:
            raise RuntimeError("thread/start 未返回线程 id")
        self.thread_id = tid
        reg = self._reg(tid)
        reg.update({"title": "新对话", "project": project, "cwd": cwd or th.get("cwd"),
                    "model": th.get("model") or model, "effort": th.get("reasoningEffort"),
                    "sandbox": None, "messages": [], "updated": time.time()})
        self._save_state()
        print(f"[bridge] 新线程 {tid} (project={project}, model={model})")

    # ---------- 事件 → 历史 + SSE ----------
    def _hist(self):
        return self._reg(self.thread_id).setdefault("messages", [])

    def _turn_msg(self, turn_id, emit=True):
        """一轮回复聚合成一条消息（delta 与 item 的 itemId 可能不同，以 turnId 为键）。
        内容按到达顺序存入 parts（text/thought/search/command），保证工具调用出现在真实位置。
        emit=False 用于占位：空消息不推给前端，避免留下空的闪烁光标节点"""
        for m in self._hist():
            if m.get("id") == turn_id:
                return m
        m = {"id": turn_id, "role": "assistant", "parts": [], "streaming": True, "ts": now_s()}
        self._hist().append(m)
        if emit:
            self.emit({"type": "item", "item": self._public(m)})
        return m

    def _on_notification(self, method, p):
        if method == "thread/started":
            th = p.get("thread", {})
            if th.get("id") == self.thread_id:
                reg = self._reg(self.thread_id)
                reg["model"] = th.get("model") or reg.get("model")
                reg["effort"] = th.get("reasoningEffort") or reg.get("effort")
                reg["cwd"] = th.get("cwd") or reg.get("cwd")
                reg["name"] = th.get("name") or reg.get("title")
                self._save_state()
        elif method == "thread/name/updated":
            tid = p.get("threadId") or self.thread_id
            if tid in self.threads:
                self.threads[tid]["title"] = p.get("name", self.threads[tid]["title"])
                self.threads[tid]["updated"] = time.time()
                self._save_state()
                self.emit({"type": "thread", "threadId": tid,
                           "title": self.threads[tid]["title"]})
        elif method == "item/agentMessage/delta":
            m = self._turn_msg(p.get("turnId") or p.get("itemId"), emit=False)
            d = p.get("delta", "")
            parts = m["parts"]
            if parts and parts[-1]["type"] == "text":
                parts[-1]["text"] += d
            else:
                parts.append({"type": "text", "text": d})
            self.emit({"type": "delta", "itemId": m["id"], "delta": d})
        elif method == "item/completed":
            item = p.get("item", {})
            it = item.get("itemType") or item.get("type")
            if it not in ("agentMessage", "agent_message", "reasoning",
                          "webSearch", "web_search", "commandExecution", "command_execution"):
                return  # 未知类型不建消息，避免空壳节点
            m = self._turn_msg(p.get("turnId") or item.get("id"), emit=False)
            if it in ("agentMessage", "agent_message"):
                # delta 已按序积累正文；仅在完全没收到 delta 时用整段文本兜底
                joined = "".join(pp["text"] for pp in m["parts"] if pp["type"] == "text")
                full = item.get("text", "")
                if full and not joined:
                    m["parts"].insert(0, {"type": "text", "text": full})
                m["streaming"] = False
                self.emit({"type": "item", "item": self._public(m)})
            elif it in ("reasoning",):
                s = (item.get("text") or "").strip()
                if s and not any(pp["type"] == "thought" and pp["text"] == s for pp in m["parts"]):
                    m["parts"].append({"type": "thought", "text": s})
                    self.emit({"type": "item", "item": self._public(m)})
            elif it in ("webSearch", "web_search"):
                q = item.get("query", "")
                if q and not any(pp["type"] == "search" and pp["query"] == q for pp in m["parts"]):
                    m["parts"].append({"type": "search", "query": q})
                    self.emit({"type": "item", "item": self._public(m)})
            elif it in ("commandExecution", "command_execution"):
                cmd = item.get("command", "")
                if cmd and not any(pp["type"] == "command" and pp["text"] == cmd for pp in m["parts"]):
                    m["parts"].append({"type": "command", "text": cmd})
                    self.emit({"type": "item", "item": self._public(m)})
        elif method == "turn/completed":
            self.busy = False
            u = (p.get("turn", {}) or {}).get("usage") or p.get("usage") or {}
            for m in list(self._hist()):
                if m.get("streaming"):
                    m["streaming"] = False
                    has_content = any((pp.get("text") or pp.get("query")) for pp in m.get("parts", []))
                    if m["role"] == "assistant" and not has_content:
                        self._hist().remove(m)
                        self.emit({"type": "remove", "id": m["id"]})
                    else:
                        self.emit({"type": "item", "item": self._public(m)})
            self._reg(self.thread_id)["updated"] = time.time()
            self._save_state()
            self.emit({"type": "turn_completed",
                       "usage": {"input": u.get("inputTokens", u.get("input_tokens")),
                                 "output": u.get("outputTokens", u.get("output_tokens"))}})
            self.emit({"type": "status", "busy": False})
        elif method == "error":
            self.emit({"type": "error", "message": str(p)})

    def _public(self, m):
        if m.get("role") == "user":
            return {k: m.get(k) for k in ("id", "role", "text", "streaming", "ts")}
        self._migrate_msg(m)
        return {k: m.get(k) for k in ("id", "role", "parts", "streaming", "ts")}

    # ---------- 对外动作 ----------
    def send(self, text):
        with self.big_lock:
            if self.busy:
                return False, "上一轮还在进行中"
            self._ensure_proc()
            self.busy = True
            reg = self._reg(self.thread_id)
            user_msg = {"id": f"u{int(time.time()*1000)}", "role": "user", "text": text,
                        "streaming": False, "ts": now_s()}
            reg.setdefault("messages", []).append(user_msg)
            reg["updated"] = time.time()
            # 首条消息自动命名（与桌面 App 行为一致）
            if reg.get("title", "新对话") == "新对话" and text:
                title = text[:24].strip() or "新对话"
                reg["title"] = title
                try:
                    self._rpc("thread/name/set", {"threadId": self.thread_id, "name": title}, timeout=10)
                except Exception:
                    pass
                self.emit({"type": "thread", "threadId": self.thread_id, "title": title})
            self._save_state()
            self.emit({"type": "item", "item": self._public(user_msg)})
            self.emit({"type": "status", "busy": True})
            threading.Thread(target=self._do_turn, args=(text,), daemon=True).start()
            return True, "ok"

    def _do_turn(self, text):
        reg = self._reg(self.thread_id)
        params = {"threadId": self.thread_id,
                  "input": [{"type": "text", "text": text}]}
        # 按线程覆盖模型 / 权限（thread/start 不收沙箱，逐轮传）
        if reg.get("model"):
            params["model"] = reg["model"]
        pol = sandbox_api(reg.get("sandbox") or "")
        if pol:
            params["sandboxPolicy"] = pol
        try:
            self._rpc("turn/start", params, timeout=30)
        except RuntimeError as e:
            msg = str(e)
            if "active writer" in msg:
                lock = LOCKS / f"{self.thread_id}.lock"
                lock.unlink(missing_ok=True)
                self.emit({"type": "notice", "message": "桌面 App 占用了线程锁，已自动清除并重试"})
                try:
                    self._rpc("turn/start", params, timeout=30)
                    return
                except RuntimeError as e2:
                    msg = str(e2)
            self.busy = False
            self.emit({"type": "error", "message": msg})
            self.emit({"type": "status", "busy": False})
        except Exception as e:
            self.busy = False
            self.emit({"type": "error", "message": str(e)})
            self.emit({"type": "status", "busy": False})

    def stop(self):
        if self.thread_id:
            try:
                self._rpc("turn/interrupt", {"threadId": self.thread_id}, timeout=10)
            except Exception:
                pass

    def new_thread(self, project=None, model=None, sandbox=None):
        with self.big_lock:
            if self.busy:
                return False, "上一轮还在进行中，请先停止"
            if project:
                if not Path(project).exists():
                    return False, f"项目路径不存在: {project}"
                if project not in self.project_paths():
                    # 首次使用的目录自动登记为项目
                    self.projects.append(project)
                    self._save_state()
            model = (model or "").strip() or None
            mode = None
            if sandbox:
                mode = SANDBOX_ALIASES.get(sandbox.lower().strip())
                if not mode:
                    return False, f"未知权限类型: {sandbox}（可用: read-only / workspace-write / danger-full-access）"
            self._ensure_proc()
            self._open_thread(project, model)
            if mode:
                self._reg(self.thread_id)["sandbox"] = mode
                self._save_state()
            self.emit({"type": "snapshot", **self.snapshot()})
            return True, "ok"

    def open_thread(self, tid):
        with self.big_lock:
            if self.busy:
                return False, "上一轮还在进行中，请先停止"
            if tid not in self.threads:
                return False, "未知会话"
            self._ensure_proc()
            try:
                self._resume(tid)
            except RuntimeError as e:
                if "no rollout" in str(e):
                    self.threads.pop(tid, None)
                    self._save_state()
                    self.emit({"type": "snapshot", **self.snapshot()})
                    return False, "该会话从未产生对话内容，已从列表移除"
                return False, str(e)
            self.emit({"type": "snapshot", **self.snapshot()})
            return True, "ok"

    def delete_thread(self, tid):
        with self.big_lock:
            if self.busy and tid == self.thread_id:
                return False, "会话正在进行中，请先停止"
            self._ensure_proc()
            try:
                self._rpc("thread/delete", {"threadId": tid}, timeout=20)
            except RuntimeError as e:
                # 无 rollout 的空壳线程没有可删的远端记录，本地移除即可
                if "no rollout" not in str(e).lower():
                    return False, str(e)
            self.threads.pop(tid, None)
            if self.thread_id == tid:
                self.thread_id = None
                self._ensure_proc()
                self._open_thread()
            self._save_state()
            self.emit({"type": "snapshot", **self.snapshot()})
            return True, "ok"

    def add_project(self, path):
        path = str(path).rstrip("\\/") 
        if not Path(path).exists():
            return False, f"路径不存在: {path}"
        if path in self.project_paths():
            return False, "项目已存在"
        self.projects.append(path)
        self._save_state()
        self.emit({"type": "snapshot", **self.snapshot()})
        return True, "ok"

    def project_paths(self):
        return [p["path"] for p in self.project_list()]


bridge = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # 静默访问日志

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/state":
            self._json(bridge.snapshot())
        elif path == "/api/last_text":
            self._json(bridge.last_text())
        elif path == "/api/events":
            self._sse()
        elif path == "/api/wait_turn":
            self._wait_turn()
        elif path in ("/", "/index.html"):
            self._file(STATIC / "index.html", "text/html")
        elif path == "/style.css":
            self._file(STATIC / "style.css", "text/css")
        elif path == "/app.js":
            self._file(STATIC / "app.js", "text/javascript")
        elif path == "/markdown.js":
            self._file(STATIC / "markdown.js", "text/javascript")
        elif path.startswith("/katex/"):
            self._katex_file(path)
        else:
            self.send_error(404)

    KATEX_TYPES = {
        ".js": "text/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
        ".ttf": "font/ttf",
    }

    def _katex_file(self, path):
        # 仅允许 /katex/ 下的静态资源（js/css/字体），resolve 后校验防路径穿越
        rel = Path(path[len("/katex/"):])
        target = (STATIC / "katex" / rel).resolve()
        root = (STATIC / "katex").resolve()
        if root not in target.parents or target.suffix.lower() not in self.KATEX_TYPES:
            return self.send_error(404)
        self._file(target, self.KATEX_TYPES[target.suffix.lower()])

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n) or b"{}"
        try:
            body = json.loads(raw)
        except UnicodeDecodeError:
            body = json.loads(raw.decode("gbk", errors="replace"))  # 命令行客户端可能发 GBK
        except json.JSONDecodeError:
            return self._json({"error": "bad json"}, 400)
        if self.path == "/api/send":
            text = (body.get("text") or "").strip()
            if not text:
                return self._json({"error": "empty"}, 400)
            ok, msg = bridge.send(text)
            self._json({"ok": ok, "message": msg}, 200 if ok else 409)
        elif self.path == "/api/stop":
            bridge.stop()
            self._json({"ok": True})
        elif self.path == "/api/new":
            ok, msg = bridge.new_thread(body.get("project"), body.get("model"), body.get("sandbox"))
            self._json({"ok": ok, "message": msg}, 200 if ok else 409)
        elif self.path == "/api/open":
            ok, msg = bridge.open_thread(body.get("threadId"))
            self._json({"ok": ok, "message": msg}, 200 if ok else 409)
        elif self.path == "/api/projects":
            ok, msg = bridge.add_project(body.get("path"))
            self._json({"ok": ok, "message": msg}, 200 if ok else 400)
        elif self.path == "/api/delete":
            ok, msg = bridge.delete_thread(body.get("threadId"))
            self._json({"ok": ok, "message": msg}, 200 if ok else 409)
        else:
            self.send_error(404)

    def _wait_turn(self):
        """长轮询：阻塞直到当前轮回复完成（busy: True→False）或超时。
        用法：POST /api/send 后调用 GET /api/wait_turn?timeout=1800，
        busy=False 时立即返回，方便外部程序（如 ZCode）挂起等待完成通知。"""
        from urllib.parse import parse_qs
        qs = parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
        try:
            timeout = min(max(float(qs.get("timeout", ["1800"])[0]), 1.0), 7200.0)
        except ValueError:
            timeout = 1800.0
        deadline = time.time() + timeout
        waited_start = time.time()
        # 已在空闲态：等一小段时间看是否有新轮次开始，避免"发完消息才调它"的竞态空转
        if not bridge.busy:
            time.sleep(0.5)
        while bridge.busy and time.time() < deadline:
            time.sleep(0.3)
        self._json({"ok": True, "busy": bridge.busy, "threadId": bridge.thread_id,
                    "waited_s": round(time.time() - waited_start, 1),
                    "timed_out": bridge.busy})

    def _file(self, path, ctype):
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            return self.send_error(404)
        self.send_response(200)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _sse(self):
        q = bridge.subscribe()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            snap = json.dumps({"type": "snapshot", **bridge.snapshot()}, ensure_ascii=False)
            self.wfile.write(f"data: {snap}\n\n".encode("utf-8"))
            self.wfile.flush()
            while True:
                try:
                    ev = q.get(timeout=15)
                    data = json.dumps(ev, ensure_ascii=False)
                    self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass
        finally:
            bridge.unsubscribe(q)


def main():
    global bridge
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    bridge = Bridge()
    while True:
        try:
            # Windows 上 allow_reuse_address 会导致多进程同时绑定同一端口（请求随机分流），
            # 必须关闭，保证端口被占时老实顺延
            ThreadingHTTPServer.allow_reuse_address = False
            srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            print(f"[server] 端口 {port} 被占用，尝试 {port+1}")
            port += 1
    url = f"http://127.0.0.1:{port}"
    (BASE / "codex-live.pid").write_text(str(os.getpid()), encoding="ascii")
    print(f"[server] Codex Live 已启动: {url}  (PID {os.getpid()}, Ctrl+C 退出)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        Path(BASE / "codex-live.pid").unlink(missing_ok=True)
        if bridge.thread_id:
            lock = LOCKS / f"{bridge.thread_id}.lock"
            lock.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
