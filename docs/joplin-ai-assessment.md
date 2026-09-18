# Joplin's built-in AI (3.7+) — impact assessment for Joplin Aide

_Read of the official specs: `ai_chat`, `ai_mcp`, `ai_sidebar_tools` (dev docs, July 2026). This is our internal read, not an official position._

_Status (2026-09): historical snapshot, written when Aide had two backends. Since then Codex and Antigravity were added (four CLI backends plus Kimi), and CLAUDE.md records the decision **not** to build a generic API-key backend: Joplin's own AI panel covers that path, and Aide's new work targets CLI-side capabilities only. Recommendation 1 below (a `joplin.ai.chat()` backend) is therefore on hold; recommendations 2 and 3 still stand._

## What Joplin 3.7 actually ships

Four distinct pieces, all framework-level (no consumer chatbot bundled beyond the sidebar):

1. **`joplin.ai.chat()` provider abstraction** — one plugin API, three built-in provider adapters:
   - OpenAI-compatible (OpenAI, Ollama, LM Studio, OpenRouter, vLLM… base URL configurable)
   - Anthropic (direct Messages API)
   - Joplin Cloud AI (reuses the sync session; no separate key; server picks the model)
   - BYO API key stored in the OS keychain. Double privacy gate: `ai.enabled` off by default + `ai.allowRemote` needed for any non-localhost provider. **v1 is single-shot text: no tool-calling, no provider-specific options.**

2. **Embeddings index** — semantic search over notes (`semantic_search_notes`).

3. **Built-in MCP server** — JSON-RPC over `POST /mcp` on the Web Clipper port (`:41184`), auth via the existing Web Clipper token. Ten purpose-built tools (`search_notes`, `semantic_search_notes`, `read_note`, `list_notebooks`, `list_tags`, `create_note`, `update_note`, `delete_note`, `manage_tags`, `create_notebook`). Write tools default **off**; per-tool toggles. External hosts (Claude Desktop, Cursor, Zed) connect and call tools; **Joplin never sees the conversation**. No stdio in v1.

4. **Tool-using AI sidebar** — the built-in sidebar becomes an agent: an agent loop (`MAX_STEPS = 8`), three tiers of tools (session/editor-coupled, workspace/MCP, plugin-registered), and a `joplin.ai.tools.register()` seam so plugins add tools that work in both the sidebar and over MCP.

## Where it overlaps Aide — and where it doesn't

| Dimension | Joplin built-in AI | Joplin Aide |
|---|---|---|
| Model access | BYO API key, per-token billing | Claude Code / Copilot / Codex / Antigravity **CLI subscriptions** (flat), or the Kimi API |
| Agent loop | Yes (sidebar, MAX_STEPS 8) | Yes (the CLI's own loop) |
| Scope | Editor-coupled + workspace tools | Whole workspace via our MCP bridge |
| Tools | 10 fixed built-ins + plugin-registered | Our 21 note tools (plus `ask_user`) |
| Write safety | per-tool on/off toggles | interactive Approve/Decline cards, session rules |
| Memory / history | none built-in | long-term memory note + conversation history/resume |
| Custom question UI | none | `ask_user` clickable options |
| Provider flexibility | OpenAI-compat / Anthropic / Cloud | whatever the chosen CLI supports |

**Net:** the offerings are adjacent, not identical. Joplin's is the zero-plugin, pay-per-token, editor-first path. Aide is the flat-rate-subscription, full-agent, workspace-first path with richer safety and memory UX. A user who already pays for a Claude/Copilot CLI subscription is exactly the user Joplin's BYO-key path does NOT serve well, and vice-versa.

## Opportunities (this helps us more than it hurts)

1. **An Aide backend on `joplin.ai.chat()`.** (On hold, see the status note at the top.) Serves users who run **no CLI at all** — including local Ollama — by reusing their configured provider. Because the v1 primitive is single-shot with no tool-calling, Aide keeps its own agent loop and note tools; we'd only borrow the provider/transport/keychain layer. Removes the biggest onboarding barrier (installing + logging into a CLI).

2. **Register Aide's tools via `joplin.ai.tools.register()`.** Our note operations could appear in Joplin's own sidebar and over its MCP endpoint — reach beyond our panel for free. Worth prototyping once the seam ships in stable.

3. **Retire our MCP stdio proxy.** Aide currently ships a hand-rolled stdio MCP proxy launched through Joplin's Electron runtime, bridging to a local control server. If Joplin's HTTP MCP endpoint is stable and exposes equivalent tools, we may be able to point the CLIs at `POST /mcp` directly and delete a whole fragile subsystem (the same subsystem behind several past bugs). Needs care: their write tools default off and are coarser than ours, and the confirmation UX is toggles vs. our cards — so we'd likely keep our own tools for the confirmation flow and only borrow transport.

## Risks / things to watch

- **Sidebar gets "good enough" for casual users.** If the built-in sidebar covers 80% of light note-editing, Aide's addressable audience narrows to power users who want subscription-based flat-rate agents, memory, and stronger safety. That's still a real, defensible niche — but we should lean into what the sidebar structurally can't do (flat-rate heavy usage, cross-tool CLI ecosystem, long-term memory, granular confirmations).
- **Positioning language.** README/store copy should make the CLI-subscription angle explicit so users self-select correctly rather than seeing Aide as a redundant second sidebar.
- **API churn.** These are pre-release specs; `joplin.ai.*` shapes may change before 3.7 stable. Don't build on them until the API lands in a stable release.

## Recommended stance

Treat the official AI as **infrastructure to build on, not a competitor to out-run**. Concretely, in priority order once 3.7 is stable:

1. Prototype the `joplin.ai.chat()` backend (biggest reach, lowest effort).
2. Evaluate pointing the CLIs at Joplin's HTTP MCP endpoint to retire our proxy.
3. Prototype `joplin.ai.tools.register()` to surface Aide tools in the native sidebar.
4. Sharpen positioning copy around the flat-rate-CLI + memory + confirmation-UX differentiators.
