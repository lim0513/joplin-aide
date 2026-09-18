# Kimi (Moonshot) backend: how it works and how to test it

Select **Kimi** in the Aide panel and set the API key in settings. No CLI:
the plugin calls Moonshot's OpenAI-compatible endpoint directly and runs its
own agent loop. Pick the endpoint that matches the key (China platform
`api.moonshot.cn` or international `api.moonshot.ai`); a key from one is
rejected by the other.

Product note: this is deliberately **not** generalized into an
"any OpenAI-compatible endpoint" backend. Joplin's own AI panel covers that,
and the decision (with the reasons) is recorded in CLAUDE.md.

## Mechanics

- `POST {baseUrl}/chat/completions` with `stream: true`, `Bearer` auth,
  the Joplin tools as standard `tools` (function calling) and
  `tool_choice: auto`. The loop runs up to 25 rounds per turn: stream the
  answer, execute any `tool_calls` through the same `executeTool` the MCP
  proxy uses (so the confirmation cards, session rules and AUTO MODE apply
  unchanged), append the results, repeat until a round has no tool calls.
- The raw API thread (`apiMessages`) is stored on the conversation and
  resent every turn; if absent (conversation started on a CLI backend, or
  rewound) it is rebuilt from the display history. The system prompt is
  re-inserted each turn, so note context and memory are always current.
- `prompt_cache_key` is set to the conversation id so Moonshot reuses its
  automatic context cache across turns (large input-cost savings).
- Web search is Moonshot's server-side `$web_search`, declared as a
  `builtin_function` tool. The model triggers it, the server runs it, and
  the client only echoes the call arguments back as the tool result. The
  `tool_call.type` must be echoed back as `builtin_function`; sending
  `function` makes the search silently return nothing. Stored
  `$web_search` turns are stripped before resending: their search ids are
  ephemeral and replaying one (especially to another model such as
  kimi-k3) fails with "tokenization failed" (v1.2.5).
- Reasoning models (kimi-k3) stream `reasoning_content` before the answer;
  it is shown in a collapsible "thinking" block, controlled by the
  "show thinking" setting. The model reasons either way.
- Attachments: images go inline as base64 `image_url` parts (replaced by
  a placeholder after the first send so they are neither resent nor
  written into conversations.json); small UTF-8 text files are inlined in
  the prompt; PDF/Office/large/binary files are uploaded to `/files` with
  `purpose: file-extract`, the server-extracted text is fetched from
  `/files/{id}/content` and the upload deleted afterwards.
- `approval_prompt` (the Claude permission bridge) is excluded from the
  tool list; every other tool definition is shared with the CLI backends.
- Stop aborts the in-flight HTTP request; the turn ends without recording
  the partial answer.

## Event mapping (SSE deltas)

| delta | panel |
|---|---|
| `choices[].delta.reasoning_content` | thinking block (if enabled) |
| `choices[].delta.content` | streaming bubble, final text recorded per round |
| `choices[].delta.tool_calls` | tool chips as calls execute (`$web_search` shown as `web_search`) |
| stream end | `turnDone`, busy cleared |

## Manual checks in Joplin

1. Ask about the open note; expect a `get_selected_note` chip.
2. Ask it to edit a test note. Decline once, verify no change; approve.
3. Ask a question that needs the web with web search on; expect a
   `web_search` chip and a sourced answer. Turn search off and ask again.
4. With kimi-k3, watch the thinking block stream and collapse; disable
   "show thinking" and confirm it disappears.
5. Attach an image, a `.md` file and a PDF in separate turns.
6. Rewind (restart from an earlier message) and continue: the API thread
   is rebuilt from the truncated history.
7. Switch from Claude to Kimi mid-conversation: the thread continues from
   the display history.

## Automated checks

None specific to Kimi; `node scripts/test-busy.cjs` covers the send lock.
