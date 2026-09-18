# Codex backend: how it works and how to test it

Select **Codex** in the Aide panel. Run `codex login` once before using it.
On Windows the plugin uses the Codex desktop app binary when present
(`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`), otherwise `codex` from
PATH; an explicit path can be set in Joplin Aide settings. Model and reasoning
effort are optional; an empty value keeps the Codex default.

## Mechanics

- Each turn spawns `codex app-server` (JSON-RPC over stdio) and resumes the
  previous thread by id, so history stays on Codex's side like the other CLIs.
  The process gets stdin EOF once `turn/completed` arrives, flushes the thread
  to disk and exits (~50 ms measured); the panel stays busy until it has.
- The Joplin tools reach Codex through the existing MCP proxy, configured per
  thread via `thread/start` `config.mcp_servers.joplin`. Nothing is written to
  the user's `~/.codex`.
- Codex asks the client before **every** MCP tool call
  (`mcpServer/elicitation/request` with `codex_approval_kind: mcp_tool_call`).
  Calls to the `joplin` server are accepted automatically because Aide's write
  tools already raise confirmation cards; calls to other MCP servers from the
  user's own Codex config raise a card first. Answering this request with an
  error, as the first build did, silently declines the tool - that is why
  "read the open note" never worked.
- Approval policy is `untrusted` with a read-only sandbox: only Codex's
  known-safe read commands run silently, every other command or file change
  raises a card. Extra permission requests (network, writes) are refused.
  On Windows every command arrives wrapped in `powershell.exe -Command "..."`
  and is classified "unknown", so even `Get-Content` prompts; the
  "additional allowed tools" setting (default
  `shell(cat),shell(Get-Content),shell(type)`) matches against the inner
  command from `commandActions` and lets file reads through without a card.
- "Extra CLI arguments" are appended to `codex app-server` and are meant for
  `-c key=value` overrides; the default `-c web_search=live` turns on the
  built-in web search, mirroring the Claude backend's WebSearch/WebFetch
  defaults.
- Stop kills the process tree (taskkill /T on Windows) and cancels open cards.
  If `thread/resume` fails (thread deleted, foreign id), the plugin reports it
  and continues in a fresh thread instead of failing every retry.

## Manual checks in Joplin

1. Ask Codex to read the open note and summarize it (the tool chip
   `get_selected_note` should appear, no approval card).
2. Send a follow-up that refers to the previous answer, then reload that chat
   from history and continue it.
3. Ask it to edit a test note. Decline once, verify no change; retry and approve.
4. Stop a response mid-stream, then send another message. Also stop while a
   confirmation card is open: the card must disappear.
5. Switch between Codex and another backend; sessions must not cross engines.
6. Attach an image and ask about it.
7. Ask it to run a shell command: a `Codex: <command>` card must appear.

## Automated checks

`node scripts/test-codex.cjs` covers JSON-RPC response routing, split UTF-8
streaming, request rejection and disconnect cleanup with a fake process.
`--live` additionally runs the installed app-server: initialize, `model/list`,
and discovery of a synthetic note tool through the real Aide MCP proxy. It
does not call a model. `node scripts/test-busy.cjs` covers the panel's busy
lock ordering and the host's concurrent-start guard.
