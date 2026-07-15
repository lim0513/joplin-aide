# Joplin Aide

An AI assistant chat panel for [Joplin](https://joplinapp.org/) — ask about your notes and let the AI read, search, create and edit them, powered by the CLI you already have: [Claude Code](https://claude.com/claude-code) or [GitHub Copilot CLI](https://github.com/features/copilot/cli).

Formerly published as *Joplin Claude*.

[中文说明](README-CN.md)


## Features

- **Dual backend** — Claude Code or GitHub Copilot CLI; a pill button in the panel header switches engines with one click (the next message starts a fresh session on the new engine)
- **Chat panel** — streaming replies rendered as full Markdown (headings, tables, code, clickable links), tool-activity chips, and a header showing which note the AI is targeting (updates live as you switch notes)
- **19 note tools** — list/search/read notes and notebooks, create/update/delete notes, tags, to-dos, note attachments, rich search syntax (`tag:`, `type:todo`, `updated:day-7`, ...)
- **Write confirmation** — every create/update/delete waits for your Approve/Decline in the panel, with an "Always (this session)" option per request kind; an optional (dangerous, off by default) auto mode approves everything. Enforced server-side, so it applies to both backends
- **Interactive questions** — the AI can ask a multiple-choice question mid-task; options render as clickable buttons and your click is returned as the answer
- **Attachments** — paperclip button, drag & drop, or paste an image straight from the clipboard
- **Conversation history** — the clock button lists past conversations; loading one restores the transcript and resumes the CLI session
- **Long-term memory** (opt-in) — the AI keeps preferences and facts you ask it to remember in a regular Joplin note ("Aide Memory"), injected into every new conversation; visible, editable and synced like any other note
- **Message actions** — hover any message for a copy button and timestamp; hover a user message to restart the conversation from that point (Claude-desktop style)
- **Uses your existing CLI login** — no API key to manage; requests go through `claude` / `copilot` with your existing subscription
- **i18n** — English, Simplified Chinese and Japanese, including the settings screen (follows Joplin's locale setting)

See [ROADMAP.md](ROADMAP.md) for the full feature history and what's planned.

## How it works

```
Panel (webview)  ←→  Plugin host (Node)
                        ├─ spawns: claude -p --output-format stream-json ...
                        │      or: copilot --output-format json ...
                        ├─ local control server (127.0.0.1, random port)
                        └─ writes MCP stdio proxy to the plugin dataDir
CLI  ── spawns ──►  MCP proxy  ── HTTP ──►  control server ──► joplin.data
```

The MCP proxy is a zero-dependency script shipped inside the plugin. The CLI launches it using **Joplin's own Electron runtime** (`ELECTRON_RUN_AS_NODE=1`), so users need no separate Node.js install. Every tool call is forwarded to the plugin's local control server, where the real work happens through the Joplin data API — including the user-confirmation step for writes.

## Install

1. Download `plugin.jpl` from the [latest release](https://github.com/lim0513/joplin-aide/releases/latest)
2. In Joplin, go to **Tools → Options → Plugins**
3. Click the gear icon and select **Install from file**
4. Choose the downloaded `.jpl` file and restart Joplin

## Requirements

- Joplin desktop 2.8+
- At least one backend CLI, installed and logged in:
  - [Claude Code](https://claude.com/claude-code) — `claude` on PATH (or set the full path in settings)
  - [GitHub Copilot CLI](https://github.com/features/copilot/cli) — `copilot` on PATH (or set the full path in settings); included with all Copilot plans, Free tier has a monthly request limit

## Settings

**Tools → Options → Joplin Aide**: AI backend, CLI command/path and model per backend, write-confirmation toggle, long-term memory (off by default; note ID and confirmation-skip under advanced), extra allowed tools and CLI arguments (advanced).

## Development

```bash
npm install
npm run dist
```

`dist/` is loadable via Joplin's **Development plugins** setting (point it at the project root). `publish/plugin.jpl` is the installable package.

## Credits

Co-developed with [Claude](https://claude.com) (Anthropic).

## License

MIT
