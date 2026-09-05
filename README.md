# CodexChat — 本地 ChatGPT 实时聊天桥

仿 Codex 桌面风格的本地网页聊天界面，通过 `codex app-server` 协议（与 ChatGPT 桌面 App 同款账号、同款线程存储）与 ChatGPT 实时对话。

```
浏览器 (static/)          server.py                codex app-server
┌─────────────┐   GET /   ┌──────────────┐   stdio   ┌────────────┐
│  界面+渲染   │ ◄──SSE────│ HTTP+SSE 服务 │ ◄─JSONL── │  (codex CLI │
│  markdown   │           │  状态/历史    │  JSON-RPC │  ChatGPT账号)│
└─────────────┘  POST /api/send └──────►──────────────────► GPT 模型
```

- **实时**：Server-Sent Events 推流，回复逐字显示，含 💭 思考过程、🔎 联网搜索、⚙ 命令执行。
- **同账号**：复用 `~/.codex/` 下的 ChatGPT 登录态，会话线程写入 Codex 的线程数据库（桌面 App 数据库同源；App 运行期不重读外部写入，需重启 App 才能看到）。
- **纯标准库**：server.py 只用 Python 标准库，零第三方依赖。
- **无 CDN**：界面与 Markdown 渲染全部本地文件，离线可用。

## 环境要求

- Windows（其他平台未测试，理论可用：把 start.bat 换成 `python server.py` 即可）
- Python 3.10+
- 已登录的 [Codex CLI](https://developers.openai.com/codex/cli/)（`codex app-server` 需在 PATH 或 `~/codex-bin/codex.exe`，可用环境变量 `CODEX_BIN` 指定）

## 使用

- 双击 `start.bat`，或 `python server.py` 后打开 `http://127.0.0.1:8765`。
- 端口被占用自动 +1，实际地址看启动输出或 `server.log`。
- 聊天记录存 `state.json`，重启服务自动续接同一线程；页面刷新通过 SSE snapshot 恢复。
- 停止服务用 `stop.bat`（只杀本项目的 server.py 进程）。

也可以作为 Agent（如 ZCode / Claude Code）的配套工具：Agent 通过 `POST /api/send` 直接向会话发消息，用户在网页旁观实时输出。参考 `skill/` 目录下的示例 skill。

## API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/state` | GET | 当前线程 + 全部消息 + 项目/会话列表（JSON） |
| `/api/events` | GET (SSE) | 实时事件流；连接即推 snapshot |
| `/api/send` | POST `{text}` | 发送消息（409 = 上一轮进行中） |
| `/api/last_text` | GET | 轻量监控：只返回最后一条 assistant 正文 + 工具调用计数（供 Agent 低 token 轮询） |
| `/api/wait_turn` | GET `?timeout=1800` | 长轮询，阻塞到当前轮完成或超时（供 Agent 挂起等待而非盲轮询） |
| `/api/new` | POST `{project?, model?, sandbox?}` | 新会话；sandbox: read-only / workspace-write / danger-full-access（支持中文别名） |
| `/api/open` | POST `{threadId}` | 切换到指定历史会话 |
| `/api/delete` | POST `{threadId}` | 删除会话 |
| `/api/projects` | POST `{path}` | 手动添加项目文件夹 |
| `/api/stop` | POST | 中断当前回合 |

## 配套 Agent Skill

`skill/SKILL.md` 是一个可直接安装到 `~/.agents/skills/chatgpt-live/` 的 skill 示例，让 Agent 学会：拉起服务、发消息、读回复、开新会话、长任务挂起等待。安装后对 Agent 说"打开实时聊天"即可。

## 已知边界

- 桌面 ChatGPT App 运行时会对最近活跃线程加「活动写入者」锁；服务端遇 "active writer" 错误会自动删锁重试。
- App 内查看本会话需重启 App（它只在启动时读线程库）。
- 服务只绑定 `127.0.0.1`，不对局域网开放。
