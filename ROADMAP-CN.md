# Joplin Aide — 开发路线图

**Joplin Aide** 的当前状态与规划——由本地 CLI 驱动的 Joplin AI 助手聊天面板。

[English](ROADMAP.md)

---

## ✅ 当前功能（v1.1.x）

**核心**（v1.0）
- 聊天面板：流式 Markdown 回复、工具活动 chip、当前笔记上下文
- 经本地 MCP 桥接的 19 个笔记工具（笔记/笔记本/标签/待办/附件的增删改查与搜索）
- 服务端强制的写操作确认，支持按类型的会话内放行；另有（危险的）全自动模式
- 交互式选择题，选项渲染为按钮
- 附件：选择器、拖放、剪贴板粘贴
- 历史会话，恢复对话并续接 CLI 会话
- 多语言：简中 / 英 / 日

**双后端**（v1.0–v1.1）
- Claude Code 与 GitHub Copilot CLI；标题栏下拉切换引擎（切换即开新会话）
- 按后端独立设置：CLI 路径、模型、允许工具、附加参数
- CLI 缺失时的友好报错（Windows GBK 兼容）

**大规模历史**（v1.1）
- 会话超长自动分段归档，向上滚动无感加载旧消息

**消息操作**（v1.1.2–v1.1.3）
- 每条消息悬停脚注：复制按钮（原始 Markdown）+ 消息时间
- 从任意用户消息处重新开始对话（Claude 桌面版同款；重启后为新会话）

**提示词与设置打磨**（v1.1.4–v1.1.5）
- 设置界面多语言
- 系统提示加固：笔记是数据库对象（禁用文件工具）、全文替换规则、跟随用户语言回复

**长期记忆**（v1.1.6）
- 可选开启：持久记忆存于普通 Joplin 笔记（"Aide Memory"），每次新会话注入
- 由 AI 用现有笔记工具自行维护；有长度上限与整理提示
- 记忆笔记的更新免确认（可配置）；删除仍需确认

**会话续接修复**（v1.1.7）
- 关键修复：Windows 上多行记忆内容进入命令行后被 cmd.exe 在换行处截断，`--resume` 被静默丢弃——每轮都变成无上下文的新会话。记忆内容已压平为单行，并加防御闸阻止任何换行进入 CLI 参数

---

## ✅ Kimi（Moonshot）API 后端（v1.2.0）

首个**不依赖 CLI** 的后端：不再 spawn 子进程，插件直接调用 Moonshot 的 OpenAI 兼容 API，并在进程内跑自己的 agentic loop。

- **进程内引擎** —— SSE 流式解析、多轮工具调用循环，复用同一套 19 个笔记工具（直接调 `executeTool`，省掉 MCP proxy），可被停止按钮中断
- **自包含** —— 无需安装 `claude`/`copilot`；适配任意 OpenAI 兼容端点
- **端点选择** —— kimi-cn（`api.moonshot.cn`）/ 国际（`api.moonshot.ai`）；模型下拉（kimi-k3、k2.7-code、k2.6、k2.5、moonshot-v1-*）；API 密钥存于 Joplin 安全设置
- **按官方手册接入的能力** —— 自动上下文缓存（`prompt_cache_key`）、内置联网搜索（`$web_search`，可开关，触发才计费）、视觉输入（图片 base64）、以及 kimi-k3 的**思考过程实时显示**（推理内容流入可折叠的「思考过程」块）
- 复用现有的审批卡片、ask_user、长期记忆、历史与附件
- 为未来「多组用户自命名的 OpenAI 兼容 bot」打好地基
- （v1.2.1）新增开关：是否显示 kimi-k3 的思考过程
- （v1.2.2）修复：联网搜索静默无结果——`$web_search` 的 tool_call 被当作 `function` 回填（应为 `builtin_function`），导致 Moonshot 跳过注入搜索结果
- （v1.2.3）Kimi 现在能读附件——聊天上传的附件和笔记里的附件都行——通过 Moonshot file-extract（PDF/Word/Excel/PPT/文本/代码）；图片走视觉输入。新增 `read_attachment` 工具让模型拉取笔记附件内容
- （v1.2.4）新增 `create_attachment` 工具（所有后端）：AI 可生成文本类文件（Markdown/CSV/JSON/SVG/HTML/代码/文本），存为 Joplin 资源并在笔记中嵌入/链接。二进制格式无法从文本生成，不在范围内
- （v1.2.5）修复：用过联网搜索的会话切到 kimi-k3 后报 “tokenization failed”——Moonshot 的搜索结果绑定临时 search_id，重放过期的会出错。现在每次请求前从历史中剔除 `$web_search` 记录（保留回答文本）；已损坏的会话在下次发消息时自愈

---

## 📌 说明：Joplin 内置 AI（3.7+）

Joplin 3.7 预发布加入了官方 AI：`joplin.ai.chat()` provider 抽象、向量索引、
基于 Web Clipper 端口的内置 **MCP server**，以及**带工具的 AI 侧栏**（agent
循环 + 会话/工作区/插件三层工具）。这与 Aide 有重叠，值得持续关注——但定位仍
错开：官方侧栏是自带 API key（按 token 计费、作用域限于当前笔记），而 Aide 跑
在 Claude Code / Copilot 的 **CLI 订阅**上，带完整 agentic 循环、写操作确认、
长期记忆和历史。官方这套对我们更多是机会（新后端、工具注册接口、也许能退役
自建 MCP 代理）而非威胁。完整评估见 `docs/joplin-ai-assessment.md`。

---

## 🧭 想法 / 以后

- [ ] 记忆辅助：一键"立即整理"、面板内查看记忆入口
- [ ] 提示词预设（按任务类型的系统提示片段）
- [x] **OpenAI Codex CLI 后端** —— 1.3.1 已上线，走 `codex app-server`（stdio 上的 JSON-RPC）而非 `codex exec`：MCP 服务配置随 `thread/start` 请求传入，无需隔离 CODEX_HOME；Codex 每次调用 MCP 工具前的审批（`mcpServer/elicitation/request`）由插件应答
- [x] **Google Antigravity CLI 后端** —— 1.3.2 已上线，走 agy 的 stream-json 驱动模式（`--input-format stream-json --output-format stream-json`，每轮一个进程，`--conversation` 续接）。MCP 配置放在插件自己的工作区（`.agents/mcp_config.json`）；headless 的 agy 无法弹窗，插件往用户的 `permissions.allow` 加一条 `mcp(joplin/*)`，AUTO MODE 对应 `--dangerously-skip-permissions`
- [ ] 按会话覆盖模型

不承诺时间——哪个被证明有用就先做哪个。
