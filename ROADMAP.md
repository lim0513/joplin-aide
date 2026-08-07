# Joplin Aide — Roadmap

Current state and direction of **Joplin Aide**, an AI assistant chat panel for Joplin powered by local CLIs.

[中文版](ROADMAP-CN.md)

---

## ✅ Current Features (v1.1.x)

**Core** (v1.0)
- Chat panel with streaming Markdown replies, tool-activity chips, current-note context
- 19 Joplin note tools over a local MCP bridge (list/search/read/create/update/delete notes, notebooks, tags, to-dos, attachments)
- Server-side write confirmation with per-kind session rules; optional (dangerous) auto mode
- Interactive multiple-choice questions rendered as buttons
- Attachments: file picker, drag & drop, clipboard paste
- Conversation history with CLI session resume
- i18n: EN / ZH-CN / JA

**Dual backend** (v1.0–v1.1)
- Claude Code and GitHub Copilot CLI; header dropdown switches engines (new session per switch)
- Per-backend settings: CLI path, model, allowed tools, extra arguments
- Friendly errors when a CLI is missing (GBK-safe on Windows)

**History at scale** (v1.1)
- Conversations archive into segments; scroll-up loads older messages seamlessly

**Message actions** (v1.1.2–v1.1.3)
- Hover footer below every bubble: copy button (raw Markdown) + message time
- Restart conversation from any user message (Claude-desktop style; starts a fresh session)

**Prompt & settings polish** (v1.1.4–v1.1.5)
- Localized settings screen
- Hardened system prompt: notes are database items (never file tools), full-body updates, reply in the user's language

**Long-term memory** (v1.1.6)
- Opt-in persistent memory in a regular Joplin note ("Aide Memory"), injected into each new conversation
- Maintained by the AI itself via the ordinary note tools; capped with a consolidation hint
- Memory-note updates skip the approval card (configurable); deletion still asks

**Session continuity fix** (v1.1.7)
- Critical: multi-line memory content in the command line was truncated by cmd.exe on Windows, silently dropping `--resume` - every turn started a fresh session with no context. Memory is now flattened to a single line and a guard keeps newlines out of all CLI arguments

---

## ✅ Kimi (Moonshot) API backend (v1.2.0)

First **CLI-free** backend: instead of shelling out, the plugin talks directly to Moonshot's OpenAI-compatible API and runs its own in-process agentic loop.

- **In-process engine** — streaming SSE parse, multi-round tool-call loop over the same 19 Joplin tools (calls `executeTool` directly; no MCP proxy), abortable from the Stop button
- **Self-contained** — no `claude`/`copilot` install needed; works on any OpenAI-compatible endpoint
- **Endpoint picker** — kimi-cn (`api.moonshot.cn`) vs international (`api.moonshot.ai`); model dropdown (kimi-k3, k2.7-code, k2.6, k2.5, moonshot-v1-*); API key stored in Joplin's secure settings
- **Capabilities wired per Moonshot docs** — automatic context caching (`prompt_cache_key`), built-in web search (`$web_search`, toggleable, billed per trigger), vision input (images as base64), and **live reasoning display** for kimi-k3 (chain-of-thought streams into a collapsible "thought process" block)
- Reuses the existing approval cards, ask_user, long-term memory, history and attachments
- Groundwork for the future "multiple user-named OpenAI-compatible bots" idea
- (v1.2.1) Setting to toggle the kimi-k3 reasoning display on/off
- (v1.2.2) Fix: web search was silently returning nothing - the `$web_search` tool_call was echoed back as `function` instead of `builtin_function`, so Moonshot skipped injecting the results
- (v1.2.3) Kimi can now read attachments - both chat uploads and note attachments - via Moonshot file-extract (PDF/Word/Excel/PowerPoint/text/code); images ride as vision input. Adds a `read_attachment` tool so the model can pull a note attachment's content
- (v1.2.4) `create_attachment` tool (all backends): the AI can author a text-based file (Markdown/CSV/JSON/SVG/HTML/code/text), save it as a Joplin resource, and embed/link it in a note. Binary formats can't be generated from text, so those are out of scope
- (v1.2.5) Fix: a conversation that had used web search failed with "tokenization failed" after switching to kimi-k3 - Moonshot ties web results to an ephemeral search_id, and replaying a stale one breaks. The stored $web_search plumbing is now stripped from history before each request (the answer text is kept); broken conversations self-heal on the next message

---

## 🧭 Ideas / Later

- [ ] Memory helpers: one-click "consolidate now", memory viewer entry in the panel
- [ ] Prompt presets (per-task system prompt snippets)
- [ ] **OpenAI Codex CLI backend** — headless story is ready (`codex exec --json` JSONL events, `exec resume`, MCP via config.toml); needs an isolated CODEX_HOME and a look at non-interactive MCP approvals
- [ ] **Google Antigravity CLI backend** (watching) — Google retires the hosted Gemini CLI for consumer tiers on 2026-06-18 in favor of Antigravity CLI; evaluate once its headless/JSON/MCP interface stabilizes
- [ ] **`joplin.ai.chat()` backend** — Joplin 3.7 adds a built-in provider abstraction (OpenAI-compatible / Anthropic / Joplin Cloud, keys in settings). A fourth Aide backend on top of it would serve users who run no CLI at all (incl. local Ollama), reusing their configured provider. Note the v1 primitive is single-shot text with no tool-calling, so Aide's agent loop + note tools would still run our side
- [ ] **Register Aide's tools with the official MCP server / `joplin.ai.tools.register()`** — 3.7 ships a built-in MCP server and (in the sidebar spec) a `joplin.ai.tools.register()` plugin seam. Evaluate exposing Aide's note operations there, and whether our own MCP stdio proxy can be retired once Joplin's HTTP MCP endpoint is stable
- [ ] Per-conversation model override

No dates promised — items move up when they prove useful.

---

## 📌 Note: Joplin's built-in AI (3.7+)

Joplin 3.7 pre-release adds first-party AI: a `joplin.ai.chat()` provider
abstraction, an embeddings index, a built-in HTTP **MCP server** on the Web
Clipper port, and a **tool-using AI sidebar** (agent loop, session + workspace +
plugin-registered tools). This overlaps Aide's space, so worth tracking
deliberately — but the positioning stays distinct: Joplin's sidebar is
BYO-API-key (per-token billing, editor-scoped) whereas Aide runs on the
Claude Code / Copilot **CLI subscriptions** with a full agentic loop, write
confirmations, long-term memory and history. The official work is more an
opportunity (new backend, tool-registration seam, possibly retiring our MCP
proxy) than a threat. See `docs/joplin-ai-assessment.md` for the full read.
