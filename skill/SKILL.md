---
name: codex-live
description: 打开 Codex Live —— 本地仿 Codex 风格的 ChatGPT 实时聊天网页。当用户想和 ChatGPT 对话/聊天并实时看到过程、提到"实时聊天""聊天界面""伪codex""打开聊天窗口"，或想让 ZCode 把消息发给 ChatGPT 且让用户旁观时使用。也适用于用户直接说 /codex-live。
---

# Codex Live — ChatGPT 实时聊天桥

一个本地网页聊天界面（Codex Live 仓库，默认克隆到 `~/codex-live`），通过 `codex app-server` 协议（桌面 App 同款账号与存储）与 ChatGPT 实时对话。浏览器经 SSE 实时显示流式回复、思考过程、联网搜索和命令执行。

> 下文以 `~/codex-live` 为例；若克隆到其他目录，替换对应路径即可。

## 何时做什么

**用户想看聊天界面 / 开始聊天** → 确保服务已启动并打开浏览器：

```powershell
# 1. 检查服务是否已在跑（有输出=已启动）
curl -s -m 2 http://127.0.0.1:8765/api/state

# 2. 没在跑就后台启动（工作目录必须在 Codex Live 目录）
cd ~/codex-live && (python -u server.py > server.log 2>&1 &)

# 3. 等待就绪（轮询直到返回 200，约 5-8 秒，app-server 启动需要时间）
curl -s -m 2 http://127.0.0.1:8765/api/state

# 4. 打开浏览器（用户自己看）
powershell -Command "Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList '--new-window','http://127.0.0.1:8765'"
```

**用户让 Agent 往对话里发消息**（用户在网页旁观）→ 直接调 API，不要操作浏览器输入框：

```bash
curl -s -X POST http://127.0.0.1:8765/api/send -H "Content-Type: application/json" -d '{"text":"消息内容"}'
```

返回 `{"ok": true}` 即已提交，回复会自动流式推到所有打开的页面。发中文时确保 UTF-8 编码（bash 单引号内的中文没问题）。

**多轮协作场景**（用户说「你和 gpt 合作完成 XX，给 gpt XX 权限、用 XX 模型」）→ 按此流程：

1. 开一个专属会话（可带项目、模型、推理强度、权限），权限词映射：只读→`read-only`，工作区写入→`workspace-write`，完全访问→`danger-full-access`：

```bash
curl -s -X POST http://127.0.0.1:8765/api/new -H "Content-Type: application/json" \
  -d '{"project":"D:\\某项目", "model":"<codex 可用模型名>", "sandbox":"danger-full-access", "effort":"medium"}'
```

   model 留空则用全局默认（`~/.codex/config.toml`）；sandbox 留空则同全局默认。有效模型名以 `codex` 配置为准。`effort` 可选 `low/medium/high/xhigh`（经 thread/start 的 config 覆盖 `model_reasoning_effort` 实现），留空用全局默认。
   注意：发 JSON 时建议用 python/文件方式构造 body——bash 单行 `-d` 里的反斜杠路径转义容易踩坑报 `bad json`。
2. `POST /api/send` 把任务描述发给 GPT（第一条消息要写清任务全貌，GPT 没有我们的对话上下文）。
3. 需要它的回复时 `GET /api/state` 读 `messages` 末尾的 assistant 内容，据此继续协作（它也会在网页上实时输出，用户可旁观）。
4. 权限按最小够用原则：纯咨询用 read-only，要改项目文件用 workspace-write，仅按用户明确指示给 danger-full-access。

**Agent 低成本监控（省 token）**：
- `GET /api/last_text` — 只返回最后一条 assistant 消息的**正文 text 段** + 命令/思考段计数 + 错误概览（`n_errors` / `unresolved_errors` / `last_error`）。勿用 `/api/state` 做轮询：其 parts 含全部命令调用文本（单轮可达 3 万字符），全量拉取浪费 token。
- **判断"在跑还是卡了"**：`last_error` 非空 = 有未恢复的错误。结合 `busy`：busy=True 且 last_error 非空 → 断线重连中；busy=False 且 last_error 非空 → 本轮已失败/卡死（`willRetry:false`）；重连成功后该错误会被标记 `resolved:true` 并移出 last_error。
- `GET /api/wait_turn?timeout=1800` — 长轮询，阻塞到当前轮完成（busy True→False）或超时才返回。用法：`POST /api/send` 后以后台 Bash（run_in_background）挂起 `curl --max-time <timeout+60>` 调它，完成即收到任务通知，替代盲目轮询。
- 长任务的进度细节：让执行者维护 STATUS.md（磁盘文件），Agent 读它而不是读消息流。

**报错可见性**：断线重连、turn/start 失败等错误会以 `role:"error"` 条目插入消息时间线（网页上按真实位置显示、可刷新恢复，不再沉底），并持久化进 `state.json`。`GET /api/state` 的 `messages` 里同样能看到，字段：`message` / `additionalDetails` / `willRetry` / `turnId` / `resolved` / `raw`。`resolved:true` = 该轮已正常收尾（重连成功）；同一次重连的多条进度（Reconnecting 1/5 → 2/5）合并为一条实时更新。

**用户想开新话题** → `curl -X POST http://127.0.0.1:8765/api/new`（网页上点「新对话」等效；加 `{"project":"路径"}` 可在项目内建）。

**用户想让 Agent 知道 ChatGPT 说了什么** → `curl -s http://127.0.0.1:8765/api/state`，`messages` 数组含全部历史（role: user/assistant/error）。

## 注意事项

- 服务常驻，聊天记录存在 `~/codex-live/state.json`，重启服务自动续接同一线程；网页刷新通过 SSE snapshot 自动恢复。
- **重启/停止服务必须用 `stop.bat`（只杀 server.py 自己的进程，按命令行匹配）。严禁 `Get-Process python | Stop-Process` 这类全量杀 python 的操作 —— 机器上可能还有 ComfyUI 等其他 python 服务。**
- 若遇到 "already has an active writer"：是桌面 ChatGPT App 占用了线程锁，服务端已自动清锁重试，无需人工干预。
- 端口从 8765 起自动顺延；若不是 8765，看 `server.log` 末尾的实际地址。
- 用户也可以直接在网页输入框打字 —— 和 Agent 发的消息进同一个会话，双方可见。
- 侧边栏「项目」与桌面 App 同源（app-server project/list）；选中项目后「新对话」会在该项目目录内建会话。左下角为真实沙箱策略、右下角为线程真实的 model+effort。
- 停止服务：结束 python 进程即可（服务退出时会清理线程锁）。
