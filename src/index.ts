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
  summary: string;
}

const SETTING_STRING = 2;
const SETTING_BOOL = 3;

/* ======================== Plugin ======================== */

joplin.plugins.register({
  onStart: async function () {
    const locale = (await joplin.settings.globalValue('locale')) || 'en_US';
    const t: I18nStrings = getI18n(locale);

    /* ---------- settings ---------- */
    await joplin.settings.registerSection('joplinAide', {
      label: 'Joplin Aide',
      iconName: 'fas fa-robot',
    });
    await joplin.settings.registerSettings({
      // Labels/descriptions come from i18n, resolved from the app locale at
      // registration time (language switches show after the app restart
      // Joplin already requires).
      'backend': {
        section: 'joplinAide', type: SETTING_STRING, value: 'claude', public: true,
        isEnum: true,
        options: { claude: 'Claude Code', copilot: 'GitHub Copilot' },
        label: t.sBackend,
        description: t.sBackendDesc,
      },
      'requireWriteConfirm': {
        section: 'joplinAide', type: SETTING_BOOL, value: true, public: true,
        label: t.sWriteConfirm,
        description: t.sWriteConfirmDesc,
      },
      'claudePath': {
        section: 'joplinAide', type: SETTING_STRING, value: '', public: true,
        subType: 'file_path', // renders a file picker in the options screen
        label: t.sClaudePath,
        description: t.sClaudePathDesc,
      },
      'claudeModel': {
        section: 'joplinAide', type: SETTING_STRING, value: '', public: true,
        label: t.sClaudeModel,
        description: t.sClaudeModelDesc,
      },
      'extraAllowedTools': {
        section: 'joplinAide', type: SETTING_STRING, value: 'WebSearch,WebFetch,Read', public: true,
        label: t.sClaudeTools,
        description: t.sClaudeToolsDesc,
      },
      // Key kept as 'extraCliArgs' so values set before the split carry over
      // (it always applied to claude only in practice).
      'extraCliArgs': {
        section: 'joplinAide', type: SETTING_STRING, value: '', public: true,
        label: t.sClaudeArgs,
        description: t.sClaudeArgsDesc,
      },
      'copilotPath': {
        section: 'joplinAide', type: SETTING_STRING, value: '', public: true,
        subType: 'file_path',
        label: t.sCopilotPath,
        description: t.sCopilotPathDesc,
      },
      'copilotModel': {
        section: 'joplinAide', type: SETTING_STRING, value: '', public: true,
        label: t.sCopilotModel,
        description: t.sCopilotModelDesc,
      },
      'copilotAllowTools': {
        section: 'joplinAide', type: SETTING_STRING, value: 'url,write', public: true,
        label: t.sCopilotTools,
        description: t.sCopilotToolsDesc,
      },
      'copilotExtraArgs': {
        section: 'joplinAide', type: SETTING_STRING, value: '', public: true,
        label: t.sCopilotArgs,
        description: t.sCopilotArgsDesc,
      },
      'autoApproveAll': {
        section: 'joplinAide', type: SETTING_BOOL, value: false, public: true, advanced: true,
        label: t.sAutoApprove,
        description: t.sAutoApproveDesc,
      },
    });

    /* ---------- panel ---------- */
    const panel = await joplin.views.panels.create('aideChatPanel');
    await joplin.views.panels.addScript(panel, 'webview/panel.css');
    await joplin.views.panels.addScript(panel, 'webview/markdown-it.min.js');
    await joplin.views.panels.addScript(panel, 'webview/panel.js');
    await joplin.views.panels.setHtml(panel, [
      '<div id="aide-root" data-i18n="' + escapeHtml(JSON.stringify(t)) + '">',
      '  <div class="cc-header"><span class="cc-title">Aide</span>',
      '    <span id="cc-note-context" class="cc-note-context"></span>',
      '    <select id="cc-backend" title="' + escapeHtml(t.titleBackend) + '">',
      '      <option value="claude">Claude</option>',
      '      <option value="copilot">Copilot</option>',
      '    </select>',
      '    <button id="cc-history" title="' + escapeHtml(t.titleHistory) + '">&#x1F550;</button>',
      '    <button id="cc-new" title="' + escapeHtml(t.titleNew) + '">&#x2795;</button>',
      '  </div>',
      '  <div id="cc-messages"></div>',
      '  <div id="cc-confirm"></div>',
      '  <div id="cc-attachments"></div>',
      '  <div class="cc-input-row">',
      '    <textarea id="cc-input" rows="3" placeholder="' + escapeHtml(t.inputPlaceholder) + '"></textarea>',
      '    <div class="cc-input-buttons">',
      '      <button id="cc-attach" title="' + escapeHtml(t.titleAttach) + '">&#x1F4CE;</button>',
      '      <input id="cc-file" type="file" multiple style="display:none;" />',
      '      <button id="cc-send" title="' + escapeHtml(t.titleSend) + '">&#x27A4;</button>',
      '      <button id="cc-stop" title="' + escapeHtml(t.titleStop) + '" style="display:none;">&#x25A0;</button>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join(''));
    await joplin.views.panels.show(panel, false);

    await joplin.commands.register({
      name: 'toggleAidePanel',
      label: 'Toggle Aide panel',
      iconName: 'fas fa-robot',
      execute: async () => {
        const visible = await joplin.views.panels.visible(panel);
        await joplin.views.panels.show(panel, !visible);
      },
    });
    await joplin.views.toolbarButtons.create('aidePanelButton', 'toggleAidePanel', 'noteToolbar');

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
        description: 'Search notes with Joplin query syntax: plain words, "exact phrase", tag:xxx, notebook:xxx, type:todo, iscompleted:0, created:20260101, updated:day-7, sourceurl:*. Returns id, title, parent_id, todo fields (max 50).',
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
        name: 'list_tags',
        description: 'List all tags (id + title).',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'get_note_tags',
        description: 'List the tags attached to a note.',
        inputSchema: { type: 'object', properties: { note_id: { type: 'string' } }, required: ['note_id'] },
      },
      {
        name: 'list_notes_by_tag',
        description: 'List notes that carry a tag (by tag id, see list_tags).',
        inputSchema: { type: 'object', properties: { tag_id: { type: 'string' } }, required: ['tag_id'] },
      },
      {
        name: 'list_note_attachments',
        description: 'List the file attachments (resources) of a note, with their LOCAL file paths. Use the Read tool with local_path to view an attachment (images, PDFs, text...).',
        inputSchema: { type: 'object', properties: { note_id: { type: 'string' } }, required: ['note_id'] },
      },
      {
        name: 'open_note',
        description: 'Open a note in the Joplin editor (navigate the user to it).',
        inputSchema: { type: 'object', properties: { note_id: { type: 'string' } }, required: ['note_id'] },
      },
      {
        name: 'append_to_note',
        description: 'Append markdown text to the END of a note. Prefer this over update_note when adding content - it cannot damage existing content.',
        write: true,
        confirmSummary: (a) => fmt(t.cAppend, { id: a.note_id, n: String(a.text || '').length }),
        inputSchema: {
          type: 'object',
          properties: { note_id: { type: 'string' }, text: { type: 'string', description: 'Markdown to append' } },
          required: ['note_id', 'text'],
        },
      },
      {
        name: 'tag_note',
        description: 'Add a tag to a note (creates the tag if it does not exist).',
        write: true,
        confirmSummary: (a) => fmt(t.cTagNote, { id: a.note_id, tag: a.tag }),
        inputSchema: {
          type: 'object',
          properties: { note_id: { type: 'string' }, tag: { type: 'string', description: 'Tag title' } },
          required: ['note_id', 'tag'],
        },
      },
      {
        name: 'untag_note',
        description: 'Remove a tag from a note.',
        write: true,
        confirmSummary: (a) => fmt(t.cUntagNote, { id: a.note_id, tag: a.tag }),
        inputSchema: {
          type: 'object',
          properties: { note_id: { type: 'string' }, tag: { type: 'string', description: 'Tag title' } },
          required: ['note_id', 'tag'],
        },
      },
      {
        name: 'set_todo_status',
        description: 'Mark a to-do note as completed or not completed.',
        write: true,
        confirmSummary: (a) => fmt(t.cSetTodo, { id: a.note_id, state: a.completed ? 'done' : 'open' }),
        inputSchema: {
          type: 'object',
          properties: { note_id: { type: 'string' }, completed: { type: 'boolean' } },
          required: ['note_id', 'completed'],
        },
      },
      {
        name: 'update_notebook',
        description: 'Rename a notebook and/or move it under another parent notebook.',
        write: true,
        confirmSummary: (a) => fmt(t.cUpdateNotebook, { id: a.notebook_id }),
        inputSchema: {
          type: 'object',
          properties: {
            notebook_id: { type: 'string' },
            title: { type: 'string', description: 'New title' },
            parent_id: { type: 'string', description: 'New parent notebook id ("" for top level)' },
          },
          required: ['notebook_id'],
        },
      },
      {
        name: 'ask_user',
        description: 'Ask the user ONE multiple-choice question and wait for their answer. Renders clickable option buttons in the chat panel. Use this whenever you need the user to pick between alternatives before proceeding. Returns the chosen option text.',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question to ask' },
            options: { type: 'array', items: { type: 'string' }, description: '2-6 short option labels' },
          },
          required: ['question', 'options'],
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

    // ask_user tool: blocks the tool call until the user clicks an option
    // in the panel (or the 5-minute timeout fires).
    const pendingQuestions: { [id: string]: { resolve: (v: string) => void; timer: any; question: string; options: string[] } } = {};
    let questionSeq = 0;

    function requestAnswer(question: string, options: string[]): Promise<string> {
      return new Promise((resolve) => {
        const id = 'q' + String(++questionSeq);
        const timer = setTimeout(() => {
          delete pendingQuestions[id];
          post({ name: 'questionGone', requestId: id });
          resolve('');
        }, 300000);
        pendingQuestions[id] = { resolve, timer, question, options };
        post({ name: 'userQuestion', requestId: id, questions: [{ question, options }] });
      });
    }

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
        pendingConfirms[id] = { resolve, timer, key, summary };
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

    // <profile>/resources holds attachment files; dataDir is <profile>/plugin-data/<id>.
    // Resolved lazily: dataDir is declared later in onStart (TDZ at this point).
    function getResourcesDir(): string {
      return nodePath.resolve(dataDir, '..', '..', 'resources');
    }

    async function findOrCreateTag(title: string, create: boolean): Promise<any> {
      const r = await joplin.data.get(['search'], { query: title, type: 'tag', fields: ['id', 'title'] });
      const lower = String(title).toLowerCase();
      const hit = (r.items || []).find((tg: any) => String(tg.title).toLowerCase() === lower);
      if (hit) return hit;
      if (!create) return null;
      return await joplin.data.post(['tags'], null, { title });
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

      if (name === 'ask_user') {
        const options = Array.isArray(args.options) ? args.options.map((o: any) => String(o)).slice(0, 6) : [];
        if (!args.question || options.length < 2) {
          return { result: 'ask_user requires a question and at least 2 options.', isError: true };
        }
        const answer = await requestAnswer(String(args.question), options);
        if (!answer) return { result: 'The user did not answer within the time limit.', isError: true };
        record('tool', 'ask_user: ' + args.question + ' -> ' + answer);
        return { result: answer };
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
          const items = await getAllPaginated(['folders', args.notebook_id, 'notes'], ['id', 'title', 'user_updated_time', 'is_todo', 'todo_completed']);
          items.sort((a, b) => (b.user_updated_time || 0) - (a.user_updated_time || 0));
          return { result: items.slice(0, 200).map((n) => ({ id: n.id, title: n.title, is_todo: n.is_todo, todo_completed: n.todo_completed })) };
        }
        case 'search_notes': {
          const r = await joplin.data.get(['search'], { query: args.query, fields: ['id', 'title', 'parent_id', 'is_todo', 'todo_completed', 'todo_due', 'user_updated_time'], limit: 50 });
          return { result: r.items };
        }
        case 'read_note':
          return { result: await joplin.data.get(['notes', args.note_id], { fields: ['id', 'title', 'body', 'parent_id', 'is_todo', 'todo_completed', 'todo_due', 'user_created_time', 'user_updated_time', 'source_url'] }) };
        case 'get_selected_note': {
          const n = await joplin.workspace.selectedNote();
          if (!n) return { result: 'No note is currently selected.', isError: true };
          return { result: { id: n.id, title: n.title, body: n.body, parent_id: n.parent_id } };
        }
        case 'list_tags':
          return { result: await getAllPaginated(['tags'], ['id', 'title']) };
        case 'get_note_tags': {
          const r = await joplin.data.get(['notes', args.note_id, 'tags'], { fields: ['id', 'title'], limit: 100 });
          return { result: r.items };
        }
        case 'list_notes_by_tag': {
          const items = await getAllPaginated(['tags', args.tag_id, 'notes'], ['id', 'title', 'parent_id', 'is_todo', 'todo_completed']);
          return { result: items.slice(0, 200) };
        }
        case 'list_note_attachments': {
          const r = await joplin.data.get(['notes', args.note_id, 'resources'], { fields: ['id', 'title', 'mime', 'file_extension', 'size'], limit: 100 });
          const items = (r.items || []).map((res: any) => ({
            id: res.id,
            title: res.title,
            mime: res.mime,
            size: res.size,
            local_path: nodePath.join(getResourcesDir(), res.id + (res.file_extension ? '.' + res.file_extension : '')),
          }));
          return { result: items.length ? items : 'This note has no attachments.' };
        }
        case 'open_note':
          await joplin.commands.execute('openNote', args.note_id);
          return { result: 'Opened.' };
        case 'append_to_note': {
          const cur = await joplin.data.get(['notes', args.note_id], { fields: ['body'] });
          const joined = String(cur.body || '').replace(/\s+$/, '') + '\n\n' + String(args.text || '');
          await joplin.data.put(['notes', args.note_id], null, { body: joined });
          post({ name: 'toolDone', text: fmt(t.dUpdated, { id: args.note_id }) });
          return { result: 'Appended.' };
        }
        case 'tag_note': {
          const tag = await findOrCreateTag(String(args.tag), true);
          await joplin.data.post(['tags', tag.id, 'notes'], null, { id: args.note_id });
          return { result: 'Tagged with "' + tag.title + '".' };
        }
        case 'untag_note': {
          const tag = await findOrCreateTag(String(args.tag), false);
          if (!tag) return { result: 'Tag not found: ' + args.tag, isError: true };
          await joplin.data.delete(['tags', tag.id, 'notes', args.note_id]);
          return { result: 'Tag removed.' };
        }
        case 'set_todo_status': {
          const n = await joplin.data.get(['notes', args.note_id], { fields: ['is_todo'] });
          if (!n.is_todo) return { result: 'This note is not a to-do.', isError: true };
          await joplin.data.put(['notes', args.note_id], null, { todo_completed: args.completed ? Date.now() : 0 });
          return { result: args.completed ? 'Marked as done.' : 'Marked as open.' };
        }
        case 'update_notebook': {
          const patch: any = {};
          if (args.title !== undefined) patch.title = args.title;
          if (args.parent_id !== undefined) patch.parent_id = args.parent_id;
          if (Object.keys(patch).length === 0) return { result: 'Nothing to update.', isError: true };
          await joplin.data.put(['folders', args.notebook_id], null, patch);
          return { result: 'Notebook updated.' };
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
            JOPLIN_AIDE_PORT: String(controlPort),
          },
        },
      },
    }, null, 2), 'utf8');
    // Copilot CLI variant of the same server config: it additionally wants
    // "type" and a "tools" allowlist inside the server entry.
    const mcpConfigCopilotPath = nodePath.join(dataDir, 'mcp-config-copilot.json');
    nodeFs.writeFileSync(mcpConfigCopilotPath, JSON.stringify({
      mcpServers: {
        joplin: {
          type: 'local',
          command: process.execPath,
          args: [proxyPath],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            JOPLIN_AIDE_PORT: String(controlPort),
          },
          tools: ['*'],
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

    // Overflow segments live next to conversations.json, one file per
    // HISTORY_SEGMENT oldest entries: history/<convId>-<seq>.json
    const HISTORY_SEGMENT = 200;
    const archiveDir = nodePath.join(dataDir, 'history');
    try { nodeFs.mkdirSync(archiveDir, { recursive: true }); } catch (_) {}
    function archiveSegPath(convId: string, seq: number): string {
      return nodePath.join(archiveDir, String(convId).replace(/[^\w-]/g, '_') + '-' + seq + '.json');
    }

    // Async, non-overlapping write: writeFileSync blocked the plugin thread
    // for tens of ms once the file grew to a few MB - felt as a hitch at the
    // end of every turn. If a save is requested while one is in flight, it
    // runs again right after (last write wins, no interleaving).
    let historyWriting = false;
    let historyDirty = false;
    async function flushHistory(): Promise<void> {
      if (historyWriting) { historyDirty = true; return; }
      historyWriting = true;
      try {
        do {
          historyDirty = false;
          conversations.sort((a, b) => (b.updated || 0) - (a.updated || 0));
          if (conversations.length > 100) conversations.length = 100;
          await nodeFs.promises.writeFile(historyPath, JSON.stringify(conversations), 'utf8');
        } while (historyDirty);
      } catch (err) {
        console.error('Joplin Aide: failed to save history', err);
      } finally {
        historyWriting = false;
      }
    }
    function saveHistory(): void {
      if (historySaveTimer) clearTimeout(historySaveTimer);
      historySaveTimer = setTimeout(() => {
        historySaveTimer = null;
        flushHistory();
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
      currentConv.messages.push({ role, text, ts: Date.now() });
      // Nothing is discarded: when a conversation exceeds 2 segments worth
      // of entries, the oldest SEGMENT of them spills into its own archive
      // file. conversations.json stays small; archives load on scroll-up.
      if (currentConv.messages.length > 2 * HISTORY_SEGMENT) {
        const spill = currentConv.messages.splice(0, HISTORY_SEGMENT);
        const seq = currentConv.archiveSegments || 0;
        try {
          nodeFs.writeFileSync(archiveSegPath(currentConv.id, seq), JSON.stringify(spill), 'utf8');
          currentConv.archiveSegments = seq + 1;
        } catch (err) {
          currentConv.messages.unshift(...spill); // keep in main file instead
          console.error('Joplin Aide: failed to write history segment', err);
        }
      }
      currentConv.updated = Date.now();
      if (sessionId) currentConv.sessionId = sessionId;
      saveHistory();
    }

    /* ---------- conversation attachments ---------- */
    const attachmentsDir = nodePath.join(dataDir, 'attachments');
    try {
      nodeFs.mkdirSync(attachmentsDir, { recursive: true });
      // Drop attachment files older than 7 days.
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      for (const f of nodeFs.readdirSync(attachmentsDir)) {
        const p = nodePath.join(attachmentsDir, f);
        try { if (nodeFs.statSync(p).mtimeMs < cutoff) nodeFs.unlinkSync(p); } catch (_) {}
      }
    } catch (_) {}

    let pendingAttachments: { id: string; fileName: string; filePath: string }[] = [];
    let attachSeq = 0;

    /* ---------- agent process management ---------- */
    let child: any = null;
    let sessionId: string = '';
    // Which backend the RUNNING child belongs to (event formats differ).
    let runBackend: string = 'claude';
    // Backend that OWNS the current sessionId. Ids don't transfer between
    // CLIs, so any mismatch - switching engines mid-chat, or loading a
    // conversation recorded on the other engine - must start fresh instead
    // of feeding a foreign id to --resume ("No session matched" errors).
    let sessionBackend: string = '';

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

    // A missing CLI otherwise dies inside cmd.exe with a localized
    // "not recognized as an internal or external command" - GBK-encoded on
    // Chinese Windows, i.e. mojibake in the panel, with no hint what to do.
    function cliExists(bin: string): boolean {
      try {
        if (bin.indexOf('/') >= 0 || bin.indexOf('\\') >= 0) return nodeFs.existsSync(bin);
        const probe = process.platform === 'win32'
          ? nodeChildProcess.spawnSync('where', [bin], { windowsHide: true })
          : nodeChildProcess.spawnSync('which', [bin]);
        return probe.status === 0;
      } catch (_) { return true; } // uncertain - let spawn find out
    }

    // stderr arrives in the console codepage, not necessarily UTF-8 (GBK on
    // Chinese Windows). Fall back to GBK when UTF-8 decoding shows damage.
    function decodeOutput(buf: any): string {
      let s = buf.toString('utf8');
      if (process.platform === 'win32' && s.indexOf('�') >= 0) {
        try { s = new TextDecoder('gbk').decode(buf); } catch (_) { /* keep utf8 */ }
      }
      return s;
    }

    async function runClaude(prompt: string): Promise<void> {
      if (child) {
        // Safety net (the webview also locks sending while busy). Reset the
        // webview's busy lock or it would stay disabled forever.
        post({ name: 'error', text: t.errAlreadyRunning });
        post({ name: 'busy', busy: true });
        return;
      }
      const backend = String((await joplin.settings.value('backend')) || 'claude');
      if (sessionId && sessionBackend && sessionBackend !== backend) { sessionId = ''; sessionAllowed = {}; }
      sessionBackend = backend;

      const extraArgs = String((await joplin.settings.value(
        backend === 'copilot' ? 'copilotExtraArgs' : 'extraCliArgs')) || '').trim();

      let noteContext = '';
      try {
        const sel = await joplin.workspace.selectedNote();
        if (sel) noteContext = ' The note currently open in the editor is "' + sel.title + '" (id: ' + sel.id + ').';
      } catch (_) {}

      const toolPrefix = backend === 'copilot' ? 'joplin MCP' : 'mcp__joplin';
      const systemPrompt = 'You are embedded in the Joplin note-taking app as an assistant. '
        + 'Use the ' + toolPrefix + ' tools to read, search, create and edit the user\'s notes and notebooks. '
        + 'Notes live in Joplin\'s database, NOT on disk: NEVER use file tools (Read/Edit/Write) or shell commands on a note, and never treat a note id or title as a file path. Every note operation goes through the ' + toolPrefix + ' tools - going file-first and correcting later wastes the user\'s time. '
        + 'Note bodies are Markdown. Updating a note replaces the FULL body: read the note first, apply your change to the complete text, then send the entire new body - never a fragment, diff or patch. '
        + 'Write operations may require user approval; if one is declined, do not retry it. '
        + 'To ask the user a multiple-choice question, use the ' + toolPrefix + ' ask_user tool - it renders clickable buttons in the panel and waits for the answer. '
        + 'Other question mechanisms do NOT work in this environment; never use them. '
        + 'Reply in the language the user writes in.'
        + noteContext;

      let bin: string;
      let args: string[];

      if (backend === 'copilot') {
        bin = String((await joplin.settings.value('copilotPath')) || '').trim() || 'copilot';
        const model = await joplin.settings.value('copilotModel');
        args = [
          '--output-format', 'json',
          '--no-color',
          '--log-level', 'none',
          '--disable-builtin-mcps',
          '--no-ask-user',
          '--additional-mcp-config', winQuote('@' + mcpConfigCopilotPath),
          '--allow-tool', 'joplin',
        ];
        // AUTO MODE parity: Claude's approval_prompt auto-approves every
        // dynamic request, but Copilot has no prompt - unallowed tools are
        // hard-denied by the CLI. Passing --allow-all-tools makes AUTO MODE
        // mean the same thing on both backends.
        if ((await joplin.settings.value('autoApproveAll')) === true) {
          args.push('--allow-all-tools');
        }
        const copilotTools = String((await joplin.settings.value('copilotAllowTools')) || '')
          .split(',').map((s: string) => s.trim()).filter((s: string) => !!s);
        for (const ct of copilotTools) { args.push('--allow-tool', winQuote(ct)); }
        if (sessionId) { args.push('--resume=' + sessionId); }
        if (model) { args.push('--model', winQuote(String(model))); }
        if (extraArgs) { args.push(extraArgs); }
      } else {
        bin = String((await joplin.settings.value('claudePath')) || '').trim() || 'claude';
        const model = await joplin.settings.value('claudeModel');
        const extraTools = String((await joplin.settings.value('extraAllowedTools')) || '')
          .split(',').map((t: string) => t.trim()).filter((t: string) => !!t);
        const allowedTools = ['mcp__joplin'].concat(extraTools).join(',');
        args = [
          '-p',
          '--output-format', 'stream-json',
          '--include-partial-messages',
          '--verbose',
          '--mcp-config', winQuote(mcpConfigPath),
          '--allowedTools', winQuote(allowedTools),
          '--permission-prompt-tool', 'mcp__joplin__approval_prompt',
          '--append-system-prompt', winQuote(systemPrompt),
        ];
        if (sessionId) { args.push('--resume', sessionId); }
        if (model) { args.push('--model', winQuote(String(model))); }
        if (extraArgs) { args.push(extraArgs); }
      }

      if (!cliExists(bin)) {
        const installCmd = backend === 'copilot'
          ? 'npm install -g @github/copilot'
          : 'npm install -g @anthropic-ai/claude-code';
        post({ name: 'error', text: fmt(t.errCliMissing, { bin, cmd: installCmd }) });
        post({ name: 'busy', busy: false });
        return;
      }

      if (pendingAttachments.length) {
        if (backend === 'copilot') {
          // Images/documents ride --attachment; everything else is listed in
          // the prompt with the attachments dir allowlisted for file reads.
          const nativeExt = /\.(png|jpe?g|gif|webp|bmp|pdf|docx|pptx|xlsx)$/i;
          const plain: string[] = [];
          let addDir = false;
          for (const a of pendingAttachments) {
            if (nativeExt.test(a.fileName)) { args.push('--attachment', winQuote(a.filePath)); }
            else { plain.push('- ' + a.filePath); addDir = true; }
          }
          if (addDir) {
            // File reads are gated by path (--add-dir), not tool permissions.
            args.push('--add-dir', winQuote(attachmentsDir));
            prompt += '\n\n[The user attached the following files. Read them from disk:]\n' + plain.join('\n');
          }
        } else {
          const attachmentLines = pendingAttachments.map((a) => '- ' + a.filePath);
          prompt += '\n\n[The user attached the following files. Use the Read tool to view them:]\n' + attachmentLines.join('\n');
        }
        pendingAttachments = [];
        post({ name: 'attachmentsCleared' });
      }
      record('user', prompt);
      // Copilot has no --append-system-prompt: context rides at the top of
      // the prompt itself (recorded history keeps the clean user text above).
      if (backend === 'copilot') {
        prompt = '<context>' + systemPrompt + '</context>\n\n' + prompt;
      }
      runBackend = backend;
      post({ name: 'busy', busy: true });
      try {
        child = nodeChildProcess.spawn(winQuote(bin), args, {
          shell: process.platform === 'win32',
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err: any) {
        post({ name: 'error', text: fmt(t.errStartFailed, { bin, err: String(err && err.message ? err.message : err) }) });
        post({ name: 'busy', busy: false });
        child = null;
        return;
      }

      child.stdin.write(prompt);
      child.stdin.end();

      let stdoutBuf = '';
      const stderrChunks: any[] = [];
      child.stdout.on('data', (chunk: any) => {
        stdoutBuf += chunk.toString('utf8');
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (line) { if (runBackend === 'copilot') handleCopilotEvent(line); else handleClaudeEvent(line); }
        }
      });
      child.stderr.on('data', (chunk: any) => { stderrChunks.push(chunk); });
      child.on('error', (err: any) => {
        post({ name: 'error', text: fmt(t.errProcess, { bin, err: String(err && err.message ? err.message : err) }) });
        post({ name: 'busy', busy: false });
        child = null;
      });
      child.on('close', (code: number) => {
        const stderrText = stderrChunks.length ? decodeOutput(Buffer.concat(stderrChunks)).trim() : '';
        if (code !== 0 && stderrText) {
          post({ name: 'error', text: fmt(t.errExited, { bin, code, err: stderrText.slice(0, 500) }) });
          // The CLI no longer knows this session (cleaned store, foreign id
          // from an old history entry...) - drop it so a retry starts fresh.
          if (/No session, task, or name matched|No conversation found/i.test(stderrText)) {
            sessionId = '';
            sessionBackend = '';
          }
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
        currentConv.backend = runBackend;
        saveHistory();
      }

      // Token-level streaming (--include-partial-messages): text deltas drive
      // a live bubble in the webview; the final 'assistant' event replaces it
      // with the complete text (authoritative, also recorded into history).
      if (ev.type === 'stream_event' && ev.event) {
        const se = ev.event;
        if (se.type === 'content_block_start' && se.content_block && se.content_block.type === 'text') {
          post({ name: 'assistantStart' });
        } else if (se.type === 'content_block_delta' && se.delta && se.delta.type === 'text_delta' && se.delta.text) {
          post({ name: 'assistantDelta', text: se.delta.text });
        }
        return;
      }

      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text) {
            record('assistant', block.text);
            post({ name: 'assistantText', text: block.text });
          } else if (block.type === 'tool_use') {
            const shortName = String(block.name || '').replace(/^mcp__joplin__/, '');
            if (shortName === 'AskUserQuestion' && block.input && Array.isArray(block.input.questions)) {
              // The interactive tool cannot render in print mode - surface the
              // question(s) as quick-reply buttons instead. Clicking one sends
              // the choice as the next user message.
              record('tool', shortName);
              post({ name: 'userQuestion', questions: block.input.questions });
            } else {
              record('tool', shortName);
              post({ name: 'toolUse', tool: shortName });
            }
          }
        }
      } else if (ev.type === 'result') {
        // Errors that end the turn WITHOUT a nonzero exit code (usage limit
        // reached, invalid API key, overloaded...) arrive here as is_error +
        // a text payload. Surface the text or the turn just silently stops.
        if (ev.is_error === true) {
          const errText = typeof ev.result === 'string' && ev.result
            ? ev.result : (ev.subtype ? String(ev.subtype) : 'Request failed.');
          post({ name: 'error', text: errText.slice(0, 500) });
        }
        post({ name: 'turnDone', isError: ev.is_error === true, costUsd: ev.total_cost_usd });
      }
    }

    // Copilot CLI --output-format json: JSONL, one event object per line.
    // Mapping: assistant.message_start/_delta -> live streaming bubble,
    // assistant.message -> authoritative final text, tool.* -> chips,
    // result -> sessionId + turn end.
    function handleCopilotEvent(line: string): void {
      let ev: any;
      try { ev = JSON.parse(line); } catch (_) { return; }
      const type = String(ev.type || '');
      const d = ev.data || {};

      if (type === 'result') {
        if (ev.sessionId) {
          sessionId = String(ev.sessionId);
          if (currentConv && currentConv.sessionId !== sessionId) {
            currentConv.sessionId = sessionId;
            currentConv.backend = runBackend;
            saveHistory();
          }
        }
        // Nonzero exit without a preceding error event (e.g. quota/billing
        // rejections): show something rather than ending silently. stderr
        // details, when present, are appended by the close handler.
        if (ev.exitCode !== 0) {
          post({ name: 'error', text: 'copilot finished with exit code ' + ev.exitCode });
        }
        post({ name: 'turnDone', isError: ev.exitCode !== 0 });
        return;
      }
      if (type === 'assistant.message_start') {
        post({ name: 'assistantStart' });
        return;
      }
      if (type === 'assistant.message_delta') {
        if (d.deltaContent) post({ name: 'assistantDelta', text: d.deltaContent });
        return;
      }
      if (type === 'assistant.message') {
        if (d.content) {
          record('assistant', d.content);
          post({ name: 'assistantText', text: d.content });
        }
        return;
      }
      // Tool lifecycle events: exact names vary between CLI versions, so
      // match defensively on the type prefix and pick the first name field.
      if (type.indexOf('tool.') === 0) {
        const rawName = String(d.toolName || d.name || d.tool || '');
        if (rawName && /start|begin|request|call/i.test(type)) {
          const shortName = rawName.replace(/^joplin[_\-]{1,2}/, '');
          record('tool', shortName);
          post({ name: 'toolUse', tool: shortName });
        }
        return;
      }
      if (/\berror\b/i.test(type)) {
        const msg = String(d.message || d.error || line).slice(0, 500);
        post({ name: 'error', text: msg });
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
          post({ name: 'conversationLoaded', id: currentConv.id, messages: currentConv.messages, archiveSegments: currentConv.archiveSegments || 0 });
        }
        post({ name: 'busy', busy: !!child });
        post({ name: 'backendState', backend: String((await joplin.settings.value('backend')) || 'claude') });
        for (const cid of Object.keys(pendingConfirms)) {
          post({ name: 'confirmWrite', requestId: cid, summary: pendingConfirms[cid].summary });
        }
        for (const qid of Object.keys(pendingQuestions)) {
          const pq = pendingQuestions[qid];
          post({ name: 'userQuestion', requestId: qid, questions: [{ question: pq.question, options: pq.options }] });
        }
      } else if (msg.name === 'send') {
        const text = String(msg.text || '').trim();
        if (text) await runClaude(text);
      } else if (msg.name === 'openUrl') {
        // Links inside rendered markdown. Only ever open http(s) in the
        // system browser; joplin:// note links navigate inside the app.
        const url = String(msg.url || '');
        if (/^https?:\/\//i.test(url)) {
          if (process.platform === 'win32') nodeChildProcess.spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
          else if (process.platform === 'darwin') nodeChildProcess.spawn('open', [url], { detached: true, stdio: 'ignore' });
          else nodeChildProcess.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
        } else if (/^:\/[0-9a-f]{32}$/i.test(url)) {
          try { await joplin.commands.execute('openNote', url.slice(2)); } catch (_) { /* note may not exist */ }
        }
      } else if (msg.name === 'setBackend') {
        // Dropdown switch from the panel header. Takes effect on the next
        // message: runClaude reads the setting per turn, and the
        // lastBackend guard starts a fresh CLI session automatically.
        const next = msg.value === 'copilot' ? 'copilot' : 'claude';
        const cur = String((await joplin.settings.value('backend')) || 'claude');
        if (next !== cur) {
          await joplin.settings.setValue('backend', next);
          post({ name: 'backendState', backend: next, switched: true });
        }
      } else if (msg.name === 'copyText') {
        // Clipboard fallback for webviews where navigator.clipboard fails.
        try { await (joplin as any).clipboard.writeText(String(msg.text || '')); } catch (_) {}
      } else if (msg.name === 'restartFrom') {
        // Rewind: drop this user message and everything after it. CLI
        // sessions can't be truncated server-side, so the next send starts
        // a FRESH session; the message text goes back to the input box.
        if (currentConv && Array.isArray(currentConv.messages)) {
          const wantTs = Number(msg.ts) || 0;
          // Live bubbles carry the webview's Date.now(), which differs by a
          // few ms from the ts record() stamped - fall back to text + window.
          let idx = currentConv.messages.findIndex((mm: any) => mm.role === 'user' && Number(mm.ts) === wantTs);
          if (idx < 0 && msg.text) {
            idx = currentConv.messages.findIndex((mm: any) =>
              mm.role === 'user' && mm.text === msg.text && Math.abs(Number(mm.ts || 0) - wantTs) < 15000);
          }
          if (idx >= 0) {
            killChild();
            currentConv.messages = currentConv.messages.slice(0, idx);
            currentConv.updated = Date.now();
            currentConv.sessionId = '';
            sessionId = '';
            sessionBackend = '';
            sessionAllowed = {};
            saveHistory();
            post({ name: 'conversationLoaded', id: currentConv.id, messages: currentConv.messages, archiveSegments: currentConv.archiveSegments || 0 });
            post({ name: 'setInput', text: String(msg.text || '') });
          }
        }
      } else if (msg.name === 'stop') {
        killChild();
      } else if (msg.name === 'newSession') {
        sessionId = '';
        sessionBackend = '';
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
          // Pre-dual-backend conversations carry no backend field - they
          // were all Claude sessions.
          sessionBackend = sessionId ? (conv.backend || 'claude') : '';
          post({ name: 'conversationLoaded', id: conv.id, messages: conv.messages || [], archiveSegments: conv.archiveSegments || 0 });
        }
      } else if (msg.name === 'loadOlder') {
        // Scroll-up pagination: hand back one archived segment (seq counts
        // from 0 = oldest; the panel requests newest-first).
        let older: any[] = [];
        try {
          const parsed = JSON.parse(nodeFs.readFileSync(archiveSegPath(String(msg.id), Number(msg.seq) | 0), 'utf8'));
          if (Array.isArray(parsed)) older = parsed;
        } catch (_) { /* segment missing - reply empty so the panel stops asking */ }
        post({ name: 'olderMessages', id: msg.id, seq: msg.seq, messages: older });
      } else if (msg.name === 'deleteConversation') {
        const gone = conversations.find((c) => c.id === msg.id);
        if (gone && gone.archiveSegments) {
          for (let s = 0; s < gone.archiveSegments; s++) {
            try { nodeFs.unlinkSync(archiveSegPath(gone.id, s)); } catch (_) {}
          }
        }
        conversations = conversations.filter((c) => c.id !== msg.id);
        if (currentConv && currentConv.id === msg.id) { currentConv = null; sessionId = ''; }
        saveHistory();
        const items = conversations
          .slice()
          .sort((a, b) => (b.updated || 0) - (a.updated || 0))
          .map((c) => ({ id: c.id, title: c.title || '(empty)', updated: c.updated }));
        post({ name: 'historyList', items });
      } else if (msg.name === 'attachFile') {
        try {
          const raw = Buffer.from(String(msg.data || ''), 'base64');
          if (raw.length > 8 * 1024 * 1024) {
            post({ name: 'error', text: fmt(t.errAttachTooBig, { name: msg.fileName }) });
            return;
          }
          const safeName = String(msg.fileName || 'file').replace(/[^\w.\-\u4e00-\u9fff\u3040-\u30ff]+/g, '_').slice(0, 80);
          const id = 'a' + (++attachSeq) + '-' + Date.now();
          const filePath = nodePath.join(attachmentsDir, id + '-' + safeName);
          nodeFs.writeFileSync(filePath, raw);
          pendingAttachments.push({ id, fileName: safeName, filePath });
          post({ name: 'attached', id, fileName: safeName });
        } catch (err: any) {
          post({ name: 'error', text: String(err && err.message ? err.message : err) });
        }
      } else if (msg.name === 'removeAttachment') {
        const found = pendingAttachments.find((a) => a.id === msg.id);
        if (found) {
          try { nodeFs.unlinkSync(found.filePath); } catch (_) {}
          pendingAttachments = pendingAttachments.filter((a) => a.id !== msg.id);
        }
        post({ name: 'attachmentRemoved', id: msg.id });
      } else if (msg.name === 'questionAnswer') {
        const pendingQ = pendingQuestions[msg.requestId];
        if (pendingQ) {
          clearTimeout(pendingQ.timer);
          delete pendingQuestions[msg.requestId];
          pendingQ.resolve(String(msg.value || ''));
        }
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
