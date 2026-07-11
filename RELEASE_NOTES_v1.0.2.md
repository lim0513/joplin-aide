## Settings overhaul

- **Write confirmation on top**: "Confirm before the AI modifies notes" now sits right under the backend picker, out of the advanced fold, and its wording makes clear it applies to both backends
- **Per-backend grouping**: Claude and Copilot fields are visually separated (`Claude · ...` / `Copilot · ...`), each group holding its own CLI path, model, allowed tools and extra CLI arguments — a shared extra-args field could inject claude-only flags into the copilot command line
- **Copilot allowed tools** with sensible defaults: `url,write` (web fetch + local file writes) out of the box; add patterns like `url(github.com)` or `shell(git:*)` as needed. Copilot has no approval prompt, so this allowlist is the only gate
- **AUTO MODE parity**: on Copilot it now passes `--allow-all-tools`, so "approve ALL permission requests" means the same thing on both engines
- Fix: attachments on Copilot no longer pass an invalid `--allow-tool read` pattern (file reads are path-gated via `--add-dir`)

**Install:** download `plugin.jpl` below → Joplin → Tools → Options → Plugins → gear icon → Install from file.
