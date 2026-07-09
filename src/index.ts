// Joplin plugin runtime provides `joplin` as a global variable at runtime.
// Do NOT `import joplin from 'api'` (webpack emits require("api") which the
// plugin loader cannot resolve - same convention as joplin-explorer).
declare const joplin: any;

const nodeHttp = require('http');
const nodeFs = require('fs');
const nodePath = require('path');
const nodeChildProcess = require('child_process');

import { MCP_PROXY_SOURCE } from './mcpSource';
import { I18nStrings, getI18n, fmt } from './i18n';

function escapeHtml(str: string): string {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ======================== Types ======================== */

interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
  write?: boolean;
  confirmSummary?: (args: any) => string;
}

interface PendingConfirm {
  resolve: (approved: boolean) => void;
  timer: any;
  key: string;
}

const SETTING_STRING = 2;
const SETTING_BOOL = 3;

/* ======================== Plugin ======================== */

joplin.plugins.register({
  onStart: async function () {
    const locale = (await joplin.settings.globalValue('locale')) || 'en_US';
    const t: I18nStrings = getI18n(locale);

    /* ---------- settings ---------- */
    await joplin.settings.registerSection('joplinClaude', {
      label: 'Joplin Claude',
      iconName: 'fas fa-robot',
    });
    await joplin.settings.registerSettings({
      'claudePath': {
        section: 'joplinClaude', type: SETTING_STRING, value: '', public: true,
        subType: 'file_path', // renders a file picker in the options screen
        label: 'Claude Code CLI path (claude.exe)',
        description: 'Full path to the claude executable. Leave empty to use "claude" from the system PATH.',
      },
      'claudeModel': {
        section: 'joplinClaude', type: SETTING_STRING, value: '', public: true,
        label: 'Model (optional)',
        description: 'Passed as --model. Leave empty to use the CLI default.',
      },
      'requireWriteConfirm': {
        section: 'joplinClaude', type: SETTING_BOOL, value: true, public: true, advanced: true,
        label: 'Confirm before Claude modifies notes',
        description: 'Create/update/delete operations wait for your approval in the chat panel.',
      },
      'autoApproveAll': {
        section: 'joplinClaude', type: SETTING_BOOL, value: false, public: true, advanced: true,
        label: '\uD83D\uDD34 \u26A0 AUTO MODE \u2014 approve ALL permission requests \u26A0',
        description: 'DANGER: when enabled, EVERY request is approved automatically without asking - note edits and deletions, AND any tool Claude asks for (potentially including shell commands). Claude gets free rein over your notes. Equivalent to running Claude Code with permissions disabled. Leave OFF unless you fully accept the risk.',
      },
      'extraAllowedTools': {
        section: 'joplinClaude', type: SETTING_STRING, value: 'WebSearch,WebFetch', public: true, advanced: true,
        label: 'Additional allowed Claude tools',
        description: 'Comma-separated Claude Code tools to auto-allow besides the Joplin note tools. Tools NOT listed here trigger an Approve/Decline card in the chat panel. Default: WebSearch,WebFetch.',
      },
      'extraCliArgs': {
        section: 'joplinClaude', type: SETTING_STRING, value: '', public: true, advanced: true,
        label: 'Extra CLI arguments',
        description: 'Advanced: appended verbatim to the claude command line.',
      },
    });

    /* ---------- panel ---------- */
    const panel = await joplin.views.panels.create('claudeChatPanel');
    await joplin.views.panels.addScript(panel, 'webview/panel.css');
    await joplin.views.panels.addScript(panel, 'webview/panel.js');
    await joplin.views.panels.setHtml(panel, [
      '<div id="claude-root" data-i18n="' + escapeHtml(JSON.stringify(t)) + '">',
      '  <div class="cc-header"><span class="cc-title">Claude</span>',
      '    <span id="cc-note-context" class="cc-note-context"></span>',
      '    <button id="cc-history" title="' + escapeHtml(t.titleHistory) + '">&#x1F550;</button>',
      '    <button id="cc-new" title="' + escapeHtml(t.titleNew) + '">&#x2795;</button>',
      '  </div>',
      '  <div id="cc-messages"></div>',
      '  <div id="cc-confirm"></div>',
      '  <div class="cc-input-row">',
      '    <textarea id="cc-input" rows="3" placeholder="' + escapeHtml(t.inputPlaceholder) + '"></textarea>',
      '    <div class="cc-input-buttons">',
      '      <button id="cc-send" title="' + escapeHtml(t.titleSend) + '">&#x27A4;</button>',
      '      <button id="cc-stop" title="' + escapeHtml(t.titleStop) + '" style="display:none;">&#x25A0;</button>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join(''));
    await joplin.views.panels.show(panel, false);

    await joplin.commands.register({
      name: 'toggleClaudePanel',
      label: 'Toggle Claude panel',
      iconName: 'fas fa-robot',
      execute: async () => {
        const visible = await joplin.views.panels.visible(panel);
        await joplin.views.panels.show(panel, !visible);
      },
    });
    await joplin.views.toolbarButtons.create('claudePanelButton', 'toggleClaudePanel', 'noteToolbar');

    // Keep the panel header showing which note Claude will target.
    async function pushNoteContext(): Promise<void> {
      try {
        const n = await joplin.workspace.selectedNote();
        post({ name: 'noteContext', title: n ? n.title : '' });
      } catch (_) {}
    }
    await joplin.workspace.onNoteSelectionChange(pushNoteContext);

    function post(msg: any): void {
      joplin.views.panels.postMessage(panel, msg);
    }

    /* ---------- tool definitions ---------- */
    const toolDefs: ToolDef[] = [
      {
        name: 'list_notebooks',
        description: 'List all notebooks (folders) with id, title and parent_id.',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'list_notes',
        description: 'List notes in a notebook (id + title, most recently updated first, max 200).',
        inputSchema: {
          type: 'object',
          properties: { notebook_id: { type: 'string', description: 'Notebook id' } },
          required: ['notebook_id'],
        },
      },
      {
        name: 'search_notes',
        description: 'Full-text search across all notes. Returns id, title and parent_id (max 50).',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Search query' } },
          required: ['query'],
        },
      },
      {
        name: 'read_note',
        description: 'Read a note: title, markdown body, notebook id.',
        inputSchema: {
          type: 'object',
          properties: { note_id: { type: 'string' } },
          required: ['note_id'],
        },
      },
      {
        name: 'get_selected_note',
        description: 'Get the note currently open in the Joplin editor (id, title, body). Use this when the user says "this note".',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'create_note',
        description: 'Create a new note in a notebook.',
        write: true,
        confirmSummary: (a) => fmt(t.cCreateNote, { title: a.title || '(untitled)' }),
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string', description: 'Markdown body' },
            notebook_id: { type: 'string', description: 'Target notebook id (optional; defaults to the currently selected notebook)' },
          },
          required: ['title', 'body'],
        },
      },
      {
        name: 'update_note',
        description: 'Update an existing note. Only the provided fields are changed. To edit content, read the note first, then send the FULL new body.',
        write: true,
        confirmSummary: (a) => fmt(t.cUpdateNote, { id: a.note_id })
          + (a.title ? fmt(t.cRetitle, { title: a.title }) : '')
          + (a.body !== undefined ? fmt(t.cBodyChars, { n: String(a.body).length }) : ''),
        inputSchema: {
          type: 'object',
          properties: {
            note_id: { type: 'string' },
            title: { type: 'string' },
            body: { type: 'string', description: 'Full replacement markdown body' },
            notebook_id: { type: 'string', description: 'Move to this notebook' },
          },
          required: ['note_id'],
        },
      },
      {
        name: 'create_notebook',
        description: 'Create a new notebook, optionally under a parent notebook.',
        write: true,
        confirmSummary: (a) => fmt(t.cCreateNotebook, { title: a.title || '' }),
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            parent_id: { type: 'string', description: 'Parent notebook id (optional)' },
          },
          required: ['title'],
        },
      },
      {
        name: 'approval_prompt',
        description: 'INTERNAL: permission prompt bridge for the Claude Code permission system. Not for direct use.',
        inputSchema: {
          type: 'object',
          properties: {
            tool_name: { type: 'string' },
            input: { type: 'object' },
            tool_use_id: { type: 'string' },
          },
          required: ['tool_name'],
        },
      },
      {
        name: 'delete_note',
        description: 'Delete a note (moves it to trash).',
        write: true,
        confirmSummary: (a) => fmt(t.cDeleteNote, { id: a.note_id }),
        inputSchema: {
          type: 'object',
          properties: { note_id: { type: 'string' } },
          required: ['note_id'],
        },
      },
    ];

    /* ---------- write confirmation ---------- */
    const pendingConfirms: { [id: string]: PendingConfirm } = {};
    let confirmSeq = 0;

    // "Always allow (this session)" grants, keyed per request kind (e.g.
    // "update_note" or "tool:Bash"). Cleared on new session / restart.
    let sessionAllowed: { [key: string]: boolean } = {};

    async function requestConfirm(summary: string, key: string): Promise<boolean> {
      // AUTO MODE: the user explicitly opted into approving everything.
      // Leave a visible trace chip in the chat for each auto-approval.
      if ((await joplin.settings.value('autoApproveAll')) === true) {
        post({ name: 'toolDone', text: fmt(t.autoApproved, { s: summary }) });
        return true;
      }
      // Session-scoped grant from a previous "Always (this session)" click.
      if (sessionAllowed[key]) {
        post({ name: 'toolDone', text: fmt(t.sessionApproved, { s: summary }) });
        return true;
      }
      return new Promise((resolve) => {
        const id = String(++confirmSeq);
        const timer = setTimeout(() => {
          delete pendingConfirms[id];
          post({ name: 'confirmGone', requestId: id });
          resolve(false);
        }, 120000);
        pendingConfirms[id] = { resolve, timer, key };
        post({ name: 'confirmWrite', requestId: id, summary });
      });
    }

    /* ---------- tool execution ---------- */
    async function getAllPaginated(path: string[], fields: string[], extra: any = {}): Promise<any[]> {
      let items: any[] = [];
      let page = 1;
      let hasMore = true;
      while (hasMore && items.length < 1000) {
        const r = await joplin.data.get(path, { fields, page, limit: 100, ...extra });
        items = items.concat(r.items);
        hasMore = r.has_more;
        page++;
      }
      return items;
    }

    async function executeTool(name: string, args: any): Promise<{ result: any; isError?: boolean }> {
      const def = toolDefs.find((d) => d.name === name);
      if (!def) return { result: 'Unknown tool: ' + name, isError: true };

      if (def.write) {
        const needConfirm = await joplin.settings.value('requireWriteConfirm');
        if (needConfirm !== false) {
          const summary = def.confirmSummary ? def.confirmSummary(args) : name;
          const ok = await requestConfirm(summary, name);
          if (!ok) return { result: 'The user DECLINED this operation. Do not retry it; ask the user what they would like instead.', isError: true };
        }
      }

      // Dynamic permission bridge: Claude Code calls this (via
      // --permission-prompt-tool) whenever a tool outside the allow-list wants
      // to run. We surface the same Approve/Decline card used for note writes.
      if (name === 'approval_prompt') {
        let detail = '';
        try {
          const raw = JSON.stringify(args.input || {});
          detail = raw.length > 160 ? raw.slice(0, 160) + '...' : raw;
        } catch (_) {}
        const ok = await requestConfirm(
          fmt(t.cToolPermission, { name: String(args.tool_name || '?') }) + (detail && detail !== '{}' ? ' ' + detail : ''),
          'tool:' + String(args.tool_name || '?'));
        return {
          result: JSON.stringify(ok
            ? { behavior: 'allow', updatedInput: args.input || {} }
            : { behavior: 'deny', message: 'The user denied this tool use.' }),
        };
      }

      switch (name) {
        case 'list_notebooks':
          return { result: await getAllPaginated(['folders'], ['id', 'title', 'parent_id']) };
        case 'list_notes': {
          const items = await getAllPaginated(['folders', args.notebook_id, 'notes'], ['id', 'title', 'user_updated_time']);
          items.sort((a, b) => (b.user_updated_time || 0) - (a.user_updated_time || 0));
          return { result: items.slice(0, 200).map((n) => ({ id: n.id, title: n.title })) };
        }
        case 'search_notes': {
          const r = await joplin.data.get(['search'], { query: args.query, fields: ['id', 'title', 'parent_id'], limit: 50 });
          return { result: r.items };
        }
        case 'read_note':
          return { result: await joplin.data.get(['notes', args.note_id], { fields: ['id', 'title', 'body', 'parent_id'] }) };
        case 'get_selected_note': {
          const n = await joplin.workspace.selectedNote();
          if (!n) return { result: 'No note is currently selected.', isError: true };
          return { result: { id: n.id, title: n.title, body: n.body, parent_id: n.parent_id } };
        }
        case 'create_note': {
          const payload: any = { title: args.title, body: args.body };
          if (args.notebook_id) payload.parent_id = args.notebook_id;
          else {
            const sel = await joplin.workspace.selectedFolder();
            if (sel) payload.parent_id = sel.id;
          }
          const created = await joplin.data.post(['notes'], null, payload);
          post({ name: 'toolDone', text: fmt(t.dCreated, { title: created.title }) });
          return { result: { id: created.id, title: created.title } };
        }
        case 'update_note': {
          const patch: any = {};
          if (args.title !== undefined) patch.title = args.title;
          if (args.body !== undefined) patch.body = args.body;
          if (args.notebook_id !== undefined) patch.parent_id = args.notebook_id;
          if (Object.keys(patch).length === 0) return { result: 'Nothing to update.', isError: true };
          await joplin.data.put(['notes', args.note_id], null, patch);
          post({ name: 'toolDone', text: fmt(t.dUpdated, { id: args.note_id }) });
          return { result: 'Note updated.' };
        }
        case 'create_notebook': {
          const payload: any = { title: args.title };
          if (args.parent_id) payload.parent_id = args.parent_id;
          const created = await joplin.data.post(['folders'], null, payload);
          return { result: { id: created.id, title: created.title } };
        }
        case 'delete_note': {
          await joplin.data.delete(['notes', args.note_id]);
          post({ name: 'toolDone', text: fmt(t.dDeleted, { id: args.note_id }) });
          return { result: 'Note deleted.' };
        }
      }
      return { result: 'Unhandled tool: ' + name, isError: true };
    }

    /* ---------- local control server (MCP proxy calls into here) ---------- */
    const controlServer = nodeHttp.createServer((req: any, res: any) => {
      const done = (code: number, obj: any) => {
        const body = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(body);
      };
      if (req.method === 'GET' && req.url === '/tools') {
        done(200, { tools: toolDefs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema })) });
        return;
      }
      if (req.method === 'POST' && req.url === '/tool') {
        const chunks: any[] = [];
        req.on('data', (c: any) => chunks.push(c));
        req.on('end', async () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            post({ name: 'toolUse', tool: payload.name });
            const out = await executeTool(payload.name, payload.arguments || {});
            done(200, out);
          } catch (err: any) {
            done(200, { result: 'Tool execution failed: ' + String(err && err.message ? err.message : err), isError: true });
          }
        });
        return;
      }
      done(404, { error: 'not found' });
    });
    await new Promise<void>((resolve) => controlServer.listen(0, '127.0.0.1', () => resolve()));
    const controlPort = controlServer.address().port;

    /* ---------- MCP proxy + config files in dataDir ---------- */
    const dataDir = await joplin.plugins.dataDir();
    const proxyPath = nodePath.join(dataDir, 'joplin-mcp-proxy.cjs');
    nodeFs.writeFileSync(proxyPath, MCP_PROXY_SOURCE, 'utf8');
    const mcpConfigPath = nodePath.join(dataDir, 'mcp-config.json');
    // process.execPath is Joplin's Electron binary; with ELECTRON_RUN_AS_NODE
    // it behaves as plain Node, so users need no separate Node install.
    nodeFs.writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        joplin: {
          command: process.execPath,
          args: [proxyPath],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            JOPLIN_CLAUDE_PORT: String(controlPort),
          },
        },
      },
    }, null, 2), 'utf8');

    /* ---------- conversation history (persisted to dataDir) ---------- */
    const historyPath = nodePath.join(dataDir, 'conversations.json');
    let conversations: any[] = [];
    try {
      conversations = JSON.parse(nodeFs.readFileSync(historyPath, 'utf8'));
      if (!Array.isArray(conversations)) conversations = [];
    } catch (_) { conversations = []; }

    let currentConv: any = null;
    let historySaveTimer: any = null;

    function saveHistory(): void {
      if (historySaveTimer) clearTimeout(historySaveTimer);
      historySaveTimer = setTimeout(() => {
        historySaveTimer = null;
        try {
          // keep the most recent 100 conversations
          conversations.sort((a, b) => (b.updated || 0) - (a.updated || 0));
          if (conversations.length > 100) conversations.length = 100;
          nodeFs.writeFileSync(historyPath, JSON.stringify(conversations), 'utf8');
        } catch (err) {
          console.error('Joplin Claude: failed to save history', err);
        }
      }, 400);
    }

    function record(role: string, text: string): void {
      if (!currentConv) {
        currentConv = {
          id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          title: '',
          sessionId: '',
          messages: [],
          updated: Date.now(),
        };
        conversations.push(currentConv);
      }
      if (role === 'user' && !currentConv.title) {
        currentConv.title = text.slice(0, 60);
      }
      currentConv.messages.push({ role, text });
      currentConv.updated = Date.now();
      if (sessionId) currentConv.sessionId = sessionId;
      saveHistory();
    }

    /* ---------- claude process management ---------- */
    let child: any = null;
    let sessionId: string = '';

    // Force-stop the running request. On Windows child.kill() only terminates
    // the wrapper shell - taskkill /T /F takes the whole process tree down so
    // the claude process (and its MCP proxy) cannot survive the stop button.
    function killChild(): void {
      if (!child) return;
      try {
        if (process.platform === 'win32') {
          nodeChildProcess.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGTERM');
        }
      } catch (_) {}
    }

    function winQuote(s: string): string {
      if (process.platform !== 'win32') return s;
      if (!/[\s"]/.test(s)) return s;
      return '"' + s.replace(/"/g, '\\"') + '"';
    }

    async function runClaude(prompt: string): Promise<void> {
      if (child) {
        // Safety net (the webview also locks sending while busy). Reset the
        // webview's busy lock or it would stay disabled forever.
        post({ name: 'error', text: t.errAlreadyRunning });
        post({ name: 'busy', busy: true });
        return;
      }
      // Empty setting = resolve "claude" via the system PATH.
      const claudePath = String((await joplin.settings.value('claudePath')) || '').trim() || 'claude';
      const model = await joplin.settings.value('claudeModel');
      const extraArgs = String((await joplin.settings.value('extraCliArgs')) || '').trim();

      let noteContext = '';
      try {
        const sel = await joplin.workspace.selectedNote();
        if (sel) noteContext = ' The note currently open in the editor is "' + sel.title + '" (id: ' + sel.id + ').';
      } catch (_) {}

      const systemPrompt = 'You are embedded in the Joplin note-taking app as an assistant. '
        + 'Use the mcp__joplin tools to read, search, create and edit the user\'s notes and notebooks. '
        + 'Note bodies are Markdown. When editing a note, read it first and provide the full new body. '
        + 'Write operations may require user approval; if one is declined, do not retry it.'
        + noteContext;

      const extraTools = String((await joplin.settings.value('extraAllowedTools')) || '')
        .split(',').map((t: string) => t.trim()).filter((t: string) => !!t);
      const allowedTools = ['mcp__joplin'].concat(extraTools).join(',');

      const args: string[] = [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--mcp-config', winQuote(mcpConfigPath),
        '--allowedTools', winQuote(allowedTools),
        '--permission-prompt-tool', 'mcp__joplin__approval_prompt',
        '--append-system-prompt', winQuote(systemPrompt),
      ];
      if (sessionId) { args.push('--resume', sessionId); }
      if (model) { args.push('--model', winQuote(String(model))); }
      if (extraArgs) { args.push(extraArgs); }

      record('user', prompt);
      post({ name: 'busy', busy: true });
      try {
        child = nodeChildProcess.spawn(winQuote(claudePath), args, {
          shell: process.platform === 'win32',
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err: any) {
        post({ name: 'error', text: fmt(t.errStartFailed, { err: String(err && err.message ? err.message : err) }) });
        post({ name: 'busy', busy: false });
        child = null;
        return;
      }

      child.stdin.write(prompt);
      child.stdin.end();

      let stdoutBuf = '';
      let stderrBuf = '';
      child.stdout.on('data', (chunk: any) => {
        stdoutBuf += chunk.toString('utf8');
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (line) handleClaudeEvent(line);
        }
      });
      child.stderr.on('data', (chunk: any) => { stderrBuf += chunk.toString('utf8'); });
      child.on('error', (err: any) => {
        post({ name: 'error', text: fmt(t.errProcess, { err: String(err && err.message ? err.message : err) }) });
        post({ name: 'busy', busy: false });
        child = null;
      });
      child.on('close', (code: number) => {
        if (code !== 0 && stderrBuf.trim()) {
          post({ name: 'error', text: fmt(t.errExited, { code, err: stderrBuf.trim().slice(0, 500) }) });
        }
        post({ name: 'busy', busy: false });
        child = null;
      });
    }

    function handleClaudeEvent(line: string): void {
      let ev: any;
      try { ev = JSON.parse(line); } catch (_) { return; }
      if (ev.session_id) sessionId = ev.session_id;

      if (currentConv && sessionId && currentConv.sessionId !== sessionId) {
        currentConv.sessionId = sessionId;
        saveHistory();
      }

      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text) {
            record('assistant', block.text);
            post({ name: 'assistantText', text: block.text });
          } else if (block.type === 'tool_use') {
            const shortName = String(block.name || '').replace(/^mcp__joplin__/, '');
            record('tool', shortName);
            post({ name: 'toolUse', tool: shortName });
          }
        }
      } else if (ev.type === 'result') {
        post({ name: 'turnDone', isError: ev.is_error === true, costUsd: ev.total_cost_usd });
      }
    }

    await pushNoteContext();

    /* ---------- webview messages ---------- */
    await joplin.views.panels.onMessage(panel, async (msg: any) => {
      if (msg.name === 'ready') {
        // The panel webview (re)loaded - Joplin recreates it on layout
        // changes, hide/show, etc. Restore the full view state, otherwise a
        // reload looks like a brand-new empty conversation.
        await pushNoteContext();
        if (currentConv && currentConv.messages && currentConv.messages.length) {
          post({ name: 'conversationLoaded', messages: currentConv.messages });
        }
        post({ name: 'busy', busy: !!child });
      } else if (msg.name === 'send') {
        const text = String(msg.text || '').trim();
        if (text) await runClaude(text);
      } else if (msg.name === 'stop') {
        killChild();
      } else if (msg.name === 'newSession') {
        sessionId = '';
        currentConv = null;
        sessionAllowed = {};
        killChild();
      } else if (msg.name === 'listHistory') {
        const items = conversations
          .slice()
          .sort((a, b) => (b.updated || 0) - (a.updated || 0))
          .map((c) => ({ id: c.id, title: c.title || '(empty)', updated: c.updated }));
        post({ name: 'historyList', items });
      } else if (msg.name === 'loadConversation') {
        const conv = conversations.find((c) => c.id === msg.id);
        if (conv) {
          killChild();
          currentConv = conv;
          sessionId = conv.sessionId || '';
          post({ name: 'conversationLoaded', messages: conv.messages || [] });
        }
      } else if (msg.name === 'deleteConversation') {
        conversations = conversations.filter((c) => c.id !== msg.id);
        if (currentConv && currentConv.id === msg.id) { currentConv = null; sessionId = ''; }
        saveHistory();
        const items = conversations
          .slice()
          .sort((a, b) => (b.updated || 0) - (a.updated || 0))
          .map((c) => ({ id: c.id, title: c.title || '(empty)', updated: c.updated }));
        post({ name: 'historyList', items });
      } else if (msg.name === 'confirmResult') {
        const pending = pendingConfirms[msg.requestId];
        if (pending) {
          clearTimeout(pending.timer);
          delete pendingConfirms[msg.requestId];
          if (msg.approved === true && msg.always === true) {
            sessionAllowed[pending.key] = true;
          }
          pending.resolve(msg.approved === true);
        }
      }
    });
  },
});
