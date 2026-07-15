# Joplin Aide

[Joplin](https://joplinapp.org/) 的 AI 助手聊天面板——让 AI 读取、搜索、创建和编辑你的笔记,由你本地已有的 CLI 驱动:[Claude Code](https://claude.com/claude-code) 或 [GitHub Copilot CLI](https://github.com/features/copilot/cli)。

前身为 *Joplin Claude*。

[English](README.md)


## 功能

- **双后端** —— Claude Code 或 GitHub Copilot CLI;面板标题栏的胶囊按钮一键切换引擎(切换后下一条消息自动开新会话)
- **聊天面板** —— 流式回复、完整 Markdown 渲染(标题、表格、代码、可点击链接)、工具活动 chip、标题栏实时显示当前操作的笔记
- **19 个笔记工具** —— 笔记/笔记本的列出、搜索、读取、创建、修改、删除,标签、待办、笔记附件,以及丰富的搜索语法(`tag:`、`type:todo`、`updated:day-7` 等)
- **写操作确认** —— 每次创建/修改/删除都等待你在面板里允许或拒绝,支持"本会话内一直允许";另有(危险、默认关闭的)全自动模式。确认在插件服务端强制执行,对两个后端同样生效
- **交互式提问** —— AI 可以在任务中途提选择题,选项渲染为按钮,点击即回答
- **附件** —— 回形针按钮、拖放,或直接从剪贴板粘贴截图
- **历史会话** —— 时钟按钮列出过往会话,加载后恢复对话并续接 CLI 会话
- **长期记忆**(可选开启)—— AI 把你的偏好和让它记住的事实保存在一篇普通 Joplin 笔记("Aide Memory")里,每次新会话自动注入;笔记可见、可编辑、随同步走
- **消息操作** —— 悬停任意消息显示复制按钮和时间;悬停用户消息可从该处重新开始对话(Claude 桌面版同款交互)
- **复用你的 CLI 登录** —— 无需管理 API key,请求走 `claude` / `copilot` 和你已有的订阅
- **多语言** —— 简体中文、English、日本語,含设置界面(跟随 Joplin 语言设置)

完整功能沿革与规划见 [ROADMAP-CN.md](ROADMAP-CN.md)。

## 工作原理

```
面板 (webview)  ←→  插件宿主 (Node)
                       ├─ 启动: claude -p --output-format stream-json ...
                       │    或: copilot --output-format json ...
                       ├─ 本地控制服务 (127.0.0.1 随机端口)
                       └─ 向插件数据目录写入 MCP stdio 代理
CLI ── 启动 ──► MCP 代理 ── HTTP ──► 控制服务 ──► joplin.data
```

MCP 代理是插件内置的零依赖脚本,由 CLI 通过 **Joplin 自带的 Electron 运行时**(`ELECTRON_RUN_AS_NODE=1`)启动,用户无需单独安装 Node.js。所有工具调用转发到插件的本地控制服务,由 Joplin 数据 API 完成实际操作——写操作的用户确认也在这一层。

## 安装

1. 从 [最新 Release](https://github.com/lim0513/joplin-aide/releases/latest) 下载 `plugin.jpl`
2. 打开 Joplin,**工具 → 选项 → 插件**
3. 点击齿轮图标,选择**从文件安装**
4. 选中下载的 `.jpl` 文件,重启 Joplin

## 前置要求

- Joplin 桌面版 2.8+
- 至少一个后端 CLI,已安装并登录:
  - [Claude Code](https://claude.com/claude-code) —— `claude` 在 PATH 中(或在设置里指定完整路径)
  - [GitHub Copilot CLI](https://github.com/features/copilot/cli) —— `copilot` 在 PATH 中(或在设置里指定完整路径);所有 Copilot 套餐均含,Free 档每月请求数有限

## 设置

**工具 → 选项 → Joplin Aide**:AI 后端、各后端的 CLI 路径和模型、写确认开关、额外放行工具与 CLI 参数(高级)。

## 开发

```bash
npm install
npm run dist
```

`dist/` 可通过 Joplin 的**开发插件**设置加载(指向工程根目录),`publish/plugin.jpl` 为安装包。

## 致谢

与 [Claude](https://claude.com)(Anthropic)共同开发。

## 许可证

MIT
