## Full history, no more lag

- **Nothing is discarded**: long conversations spill their oldest entries into per-conversation archive files (`history/<id>-<seq>.json`); the main `conversations.json` only holds each conversation's recent tail, so saving stays fast no matter how long you chat
- **Seamless scroll-up**: scrolling near the top pages in older messages automatically — first from memory, then from archive files — with the viewport anchored so nothing jumps. No buttons
- **Async saves**: history writes no longer block the plugin at the end of each turn (the old synchronous full-file rewrite caused a visible hitch once the file grew)
- Deleting a conversation also removes its archive files

## UI

- The header **backend switcher is now a dropdown** (the click-to-toggle pill was too easy to hit accidentally)

**Install:** download `plugin.jpl` below → Joplin → Tools → Options → Plugins → gear icon → Install from file.
