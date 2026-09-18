# Antigravity backend: how it works and how to test it

Select **Antigravity** in the Aide panel. Install the CLI from
https://antigravity.google/docs/cli/install/ and run `agy` once in a terminal
to sign in (the plugin cannot do that for you). On Windows the plugin uses
`%LOCALAPPDATA%\agy\bin\agy.exe` when present, otherwise `agy` from PATH; an
explicit path can be set in Joplin Aide settings.

The transport was exercised against a signed-in agy 1.2.5 with the plugin's
launch flags (see the last bullet under Mechanics); the Joplin UI flow itself
still needs the manual checks at the end.

## Mechanics

- Each turn spawns `agy --input-format stream-json --output-format stream-json`
  (driver mode, agy >= 1.1.15) and writes one line to stdin:
  `{"event":"user","message":{"content":"<context>...</context>\n\n<prompt>"}}`,
  then closes stdin. agy runs the turn, prints NDJSON events and exits 0.
  `--print` is not used because it takes the prompt from the command line.
- The conversation id arrives in the `init` event and is stored on the
  conversation; later turns pass `--conversation <id>`. If agy exits before
  `init` (unknown id, auth failure) the id is dropped so the retry starts
  fresh.
- agy's cwd and `--add-dir` point at a plugin-owned workspace,
  `<plugin data>/antigravity-workspace/`, which holds
  `.agents/mcp_config.json` with the Aide MCP proxy. The user's global
  `~/.gemini/config/mcp_config.json` is untouched. The attachments folder is a
  second `--add-dir` so agy's file tool can read attachments.
- Headless agy cannot ask for permission: a tool that needs approval is
  soft-denied and the turn ends with an empty reply. Unconfigured MCP tools
  default to Ask, so before each run the plugin makes sure
  `~/.gemini/antigravity-cli/settings.json` has `mcp(joplin/*)` in
  `permissions.allow` (one rule added, nothing else changed; the file is
  created if missing). Note writes are still gated by Aide's own confirmation
  cards inside the tools.
- Anything else agy wants (shell commands, web access, other MCP servers) is
  governed by that same `permissions.allow` list. The "additional allowed
  tools" setting (default `read_url(*)`, i.e. web fetch/search, mirroring the
  Claude backend's WebSearch/WebFetch defaults) holds the rules Aide keeps
  there on the user's behalf; a hidden setting remembers what Aide wrote so a
  rule removed from the setting is removed from the file again, while rules
  the user typed into the file by hand are never touched. A denial shows up
  in the panel as an error naming the tool. AUTO MODE passes
  `--dangerously-skip-permissions`, like Copilot's `--allow-all-tools`.
- Verified live against agy 1.2.5 (2026-09-18) with the plugin's exact launch
  flags and a synthetic note server: the workspace `mcp_config.json` is
  picked up, the Joplin tool runs as `call_mcp_tool` with
  `tool_info.parameters.{ServerName,ToolName}` (the chip is named after
  `ToolName`), `--conversation` resumes with full memory of the previous
  turn, and the process exits 0 a few seconds after `result`. Before calling
  an MCP tool agy `view_file`s its cached schema under
  `~/.gemini/antigravity-cli/mcp/<server>/`; those steps are hidden.
- Context (system prompt, current note, memory) rides at the top of the user
  message inside `<context>` tags, as with Copilot.
- `--model` is optional; ids from `agy models` already carry the effort
  suffix, so there is no separate effort setting. Extra CLI arguments are
  appended verbatim.

## Event mapping

| agy event | panel |
|---|---|
| `init` | conversation id saved |
| `step_update` `agent_response` with `text_delta` | streaming bubble; final text recorded at `DONE` |
| `step_update` `tool` `ACTIVE` | tool chip |
| `step_update` `tool` `ERROR` "permission check failed" | remembered, reported at `result` |
| `result` | turn end; `status != SUCCESS` and denials shown as errors |

## Manual checks in Joplin

1. Ask Antigravity to read the open note and summarize it. Expect a
   `get_selected_note` chip and an answer. If you instead get "Antigravity
   denied ..." check that `mcp(joplin/*)` is in settings.json.
2. Send a follow-up referring to the previous answer, then reload the chat
   from history and continue it.
3. Ask it to edit a test note. Decline once, verify no change; retry and
   approve.
4. Stop a response mid-stream, then send another message.
5. Switch between Antigravity and another backend; sessions must not cross.
6. Attach a text file and ask about it.
7. Ask it to run a shell command without an allow rule: expect the denial
   error, not a hang.
