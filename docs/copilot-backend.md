# GitHub Copilot CLI backend: how it works and how to test it

Select **Copilot** in the Aide panel. Install the CLI
(`npm install -g @github/copilot`) and log in once; `copilot` must be on PATH
or its full path set in Joplin Aide settings. Included with all Copilot
plans; the Free tier has a monthly request limit.

## Mechanics

- Each turn spawns `copilot --output-format json --no-color --log-level none
  --disable-builtin-mcps --no-ask-user` with the prompt on stdin. Windows
  spawns through `cmd.exe`, so arguments go through `winQuote`.
- The Joplin tools come from the same MCP stdio proxy as the Claude backend,
  but Copilot wants its own config shape: `--additional-mcp-config
  @<data dir>/mcp-config-copilot.json`, whose server entry carries
  `type: local` and a `tools: ["*"]` allowlist.
- Permissions are the big difference. Non-interactive Copilot has **no
  approval callback**: a tool that is not covered by `--allow-tool` is
  hard-denied by the CLI and the plugin never hears about it, so there is
  no card to show. The plugin always passes `--allow-tool joplin`; the
  "additional allowed tools" setting adds more permission patterns
  (`url`, `url(domain)`, `write`, `shell(cmd:*)`), default `url,write`.
  AUTO MODE passes `--allow-all-tools` so it means the same thing as on the
  Claude backend. Note writes are still gated by Aide's own cards inside
  the tools.
- There is no `--append-system-prompt`: the system prompt (role, tool rules,
  current note, memory) is prepended to the user message inside
  `<context>...</context>` tags. History records the clean user text.
- Sessions: the `sessionId` from the `result` event is stored on the
  conversation and passed back as `--resume=<id>`. A non-zero exit with
  "No session, task, or name matched" on stderr drops the id.
- Attachments: images and documents ride `--attachment <path>`; anything
  else is listed in the prompt and the attachments folder is added with
  `--add-dir` (file reads are gated by path, not by tool permission).
- `--no-ask-user` disables Copilot's own question tool; the Joplin
  `ask_user` tool renders option buttons instead.

## Event mapping (`--output-format json`, one object per line)

| event | panel |
|---|---|
| `assistant.message_start` | streaming bubble opens |
| `assistant.message_delta` `deltaContent` | delta appended |
| `assistant.message` `content` | authoritative text, recorded |
| `tool.*` with start/begin/request/call in the type | tool chip (prefix `joplin-` stripped); names vary between CLI versions, so matching is by prefix |
| `*error*` | error bubble |
| `result` | session id captured; `exitCode != 0` shows an error since the CLI may exit quietly on quota/billing rejections |

## Manual checks in Joplin

1. Ask about the open note; expect a `get_selected_note` chip.
2. Ask it to edit a test note. Decline once, verify no change; approve.
3. Ask it to run a shell command with the default allow list: expect the
   model to report the tool was denied (no card can appear).
4. Attach an image and ask about it (`--attachment`); attach a `.txt` and
   ask about it (`--add-dir`).
5. Stop a response, then send another message.
6. Switch to Claude and back; each switch starts a new session.

## Automated checks

`node scripts/test-busy.cjs` covers the shared send lock and start guard.
