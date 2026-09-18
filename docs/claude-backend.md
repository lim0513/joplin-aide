# Claude Code backend: how it works and how to test it

Select **Claude** in the Aide panel (the default). Install Claude Code
(`npm install -g @anthropic-ai/claude-code`) and log in once; `claude` must be
on PATH or its full path set in Joplin Aide settings.

## Mechanics

- Each turn spawns `claude -p --output-format stream-json
  --include-partial-messages --verbose` with the prompt on stdin (which is
  then closed). Windows spawns through `cmd.exe` (`shell: true`), so every
  argument that can contain spaces or quotes goes through `winQuote`.
- The Joplin tools come from the plugin's MCP stdio proxy, passed as
  `--mcp-config <data dir>/mcp-config.json`. The proxy is Joplin's own
  Electron binary run with `ELECTRON_RUN_AS_NODE=1`, so users need no Node
  install; it forwards `tools/list` and `tools/call` to a local HTTP control
  server inside the plugin, where `joplin.data` does the work.
- Permissions: `--allowedTools mcp__joplin,<extra allowed tools>` plus
  `--permission-prompt-tool mcp__joplin__approval_prompt`. Anything not on
  the allow list makes Claude call `approval_prompt`, which the control
  server turns into an Approve/Decline card and answers with
  `{behavior: allow|deny}`. Note writes are gated separately inside the
  tools themselves (confirmation cards, "Always this session", AUTO MODE),
  so the two layers never double-prompt for the same action. Default extra
  allowed tools: `WebSearch,WebFetch,Read` (Read is what views chat and note
  attachments without a prompt).
- The system prompt (role, tool rules, current note title/id, long-term
  memory) rides `--append-system-prompt`. Because it travels on the
  command line, it is flattened to one line first: cmd.exe truncates at the
  first newline and silently drops every later flag, which is exactly how
  enabling memory once broke `--resume` (v1.1.6). Never let a newline reach
  an argument on Windows.
- Sessions: the `session_id` from the event stream is stored on the
  conversation and passed back as `--resume <id>`. If the CLI exits non-zero
  with "No conversation found" on stderr, the id is dropped so the retry
  starts fresh. Ids are backend-specific; switching engines or loading a
  conversation recorded on another engine starts a new session.
- Attachments are listed in the prompt by path with "use the Read tool";
  the attachments folder lives in the plugin data dir and is pruned after
  7 days.
- stderr is decoded as UTF-8 with a GBK fallback: on Chinese Windows the
  console codepage produces mojibake otherwise. A missing binary is caught
  before spawning (`where`/`which`) so the user sees an install hint, not
  cmd.exe's localized "not recognized" text.

## Event mapping

| stream-json event | panel |
|---|---|
| `stream_event` `content_block_start` (text) | streaming bubble opens |
| `stream_event` `content_block_delta` `text_delta` | delta appended |
| `assistant` message with `text` blocks | authoritative text replaces the bubble, recorded to history |
| `assistant` message with `tool_use` blocks | tool chip (prefix `mcp__joplin__` stripped); `AskUserQuestion` becomes option buttons |
| `result` | turn end; `is_error` shows the result text (usage limit, bad key...) which would otherwise be silent |
| process `close` | busy cleared; non-zero exit shows stderr |

## Manual checks in Joplin

1. Ask about the open note; expect a `get_selected_note` chip, no card.
2. Ask it to edit a test note. Decline once, verify no change; approve on
   retry. Try "Always (this session)".
3. Ask it to run a shell command: expect a `Tool permission: Bash` card.
4. Enable long-term memory, ask it to remember something, start a new
   conversation and check it is recalled (memory writes skip the card by
   default).
5. Stop a response mid-stream, then send another message.
6. Attach a PDF and ask about it (Read is allowed by default).

## Automated checks

`node scripts/test-busy.cjs` covers the send lock and the host's
concurrent-start guard shared by all CLI backends.
