## 产品方向（2026-09 决定）

Joplin 官方内置了 AI Chat 面板，配置方式是任意 OpenAI 兼容端点（`https://api.openai.com/v1`、Ollama 的 `http://localhost:11434/v1` 等）。

**决定：不做通用 OpenAI 兼容后端。** 官方已经覆盖这块，重复投入没意义。aide 的差异化收在两个 **CLI 后端**（Claude Code / GitHub Copilot）：它们走用户自己的订阅、不按 token 计费、自带 agent loop 和工具权限，这是官方那条纯 API 路径给不了的。今后新功能只针对官方不支持的 CLI 侧能力。

评估过一次，结论记在这里以免重复讨论：

- Kimi 后端**本来就是照 OpenAI 规范写的**（`POST {baseUrl}/chat/completions`、`Bearer` 鉴权、标准 `tools` + 流式 `tool_calls`），通用化的工程成本很低。
- 真正绑死 Moonshot 的只有两处硬依赖：`$web_search`（`builtin_function` 类型，别家会因未知 tool type 直接报错）和 `kimiExtractFile`（`/files` 上传 + 服务端抽取，OpenAI 语义不同、Ollama 根本没有）。另有两处软依赖，缺了只是功能不显示：`reasoning_content`、`prompt_cache_key`。
- 所以这**不是"做不了"，是"不值得做"**。看到这段就别再提方案了。

顺带记一个通用方案本身的坑（如果哪天真要做）：aide 的全部能力都跑在多轮 function calling 上。一个端点能连上、能流式聊天，**不代表它能可靠连续调用工具**——Ollama 上的小模型尤其如此。用户会觉得"插件坏了"而不是"模型不行"，而这在配置界面上完全看不出来。

## npm 发布方式迁移备忘（截止 2027-01）

npm 安全策略收紧（github.blog changelog 2026-07-08）：

- 2026-08 起：绕过 2FA 的 token 不能再做账号/包管理操作（本仓库只用它 publish，无影响）
- **2027-01 起：绕过 2FA 的 token 不能再直接 npm publish —— 当前发布流程会失效**
- 届时迁移到 trusted publishing（OIDC）：GitHub Actions 打 tag 触发构建+发布，npm 包与仓库绑定，无需长期 token
- 当前流程：发布时写临时 .npmrc + Automation token（token 位置见 D:\repos\.npm-publish-token.txt，短期有效，过期找用户要新的）
- 另：npm v12 起 install 默认禁用依赖的 postinstall/git/remote —— 升级 npm 后构建异常先查这个（npm approve-scripts）
