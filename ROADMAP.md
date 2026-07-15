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

## 🧭 Ideas / Later

- [ ] Memory helpers: one-click "consolidate now", memory viewer entry in the panel
- [ ] Prompt presets (per-task system prompt snippets)
- [ ] **OpenAI Codex CLI backend** — headless story is ready (`codex exec --json` JSONL events, `exec resume`, MCP via config.toml); needs an isolated CODEX_HOME and a look at non-interactive MCP approvals
- [ ] **Google Antigravity CLI backend** (watching) — Google retires the hosted Gemini CLI for consumer tiers on 2026-06-18 in favor of Antigravity CLI; evaluate once its headless/JSON/MCP interface stabilizes
- [ ] Per-conversation model override

No dates promised — items move up when they prove useful.
