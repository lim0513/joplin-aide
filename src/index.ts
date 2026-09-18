// Joplin plugin runtime provides `joplin` as a global variable at runtime.
// Do NOT `import joplin from 'api'` (webpack emits require("api") which the
// plugin loader cannot resolve - same convention as joplin-explorer).
declare const joplin: any;

const nodeHttp = require('http');
const nodeHttps = require('https');
const nodeFs = require('fs');
const nodePath = require('path');
const nodeChildProcess = require('child_process');

import { MCP_PROXY_SOURCE } from './mcpSource';
import { CodexClient, splitArgs } from './codex';
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
      // Not user-facing: set by the "Don't show again" link on the privacy
      // notice in the panel. A setting rather than webview localStorage
      // because Joplin recreates the panel webview on every layout change.
      'privacyNoticeDismissed': {
        section: 'joplinAide', type: SETTING_BOOL, value: false, public: false,
        label: 'Privacy notice dismissed',
      },
      'backend': {
        section: 'joplinAide', type: SETTING_STRING, value: 'claude', public: true,
        isEnum: true,
        options: { claude: 'Claude Code', copilot: 'GitHub Copilot', codex: 'Codex', antigravity: 'Antigravity', kimi: 'Kimi (Moonshot)' },
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
      // Kimi is a self-contained backend: the plugin calls Moonshot's
      // OpenAI-compatible endpoint directly (no CLI). It runs its own in-process
      // agentic loop over the same Joplin tools.
      'kimiBaseUrl': {
        section: 'joplinAide', type: SETTING_STRING, value: 'https://api.moonshot.cn/v1', public: true,
        isEnum: true,
        options: {
          'https://api.moonshot.cn/v1': 'kimi-cn · 国内平台 (platform.moonshot.cn)',
          'https://api.moonshot.ai/v1': 'international · 国际平台 (platform.moonshot.ai)',
        },
        label: t.sKimiBaseUrl,
        description: t.sKimiBaseUrlDesc,
      },
      'kimiApiKey': {
        section: 'joplinAide', type: SETTING_STRING, value: '', public: true, secure: true,
        label: t.sKimiKey,
        description: t.sKimiKeyDesc,
      },
      'kimiModel': {
        section: 'joplinAide', type: SETTING_STRING, value: 'kimi-k3', public: true,
        isEnum: true,
        options: {
          'kimi-k3': 'kimi-k3 (旗舰, 1M 上下文)',
          'kimi-k2.7-code': 'kimi-k2.7-code',
          'kimi-k2.7-code-highspeed': 'kimi-k2.7-code-highspeed',
          'kimi-k2.6': 'kimi-k2.6',
          'kimi-k2.5': 'kimi-k2.5',
          'moonshot-v1-auto': 'moonshot-v1-auto',
          'moonshot-v1-8k': 'moonshot-v1-8k',
          'moonshot-v1-32k': 'moonshot-v1-32k',
          'moonshot-v1-128k': 'moonshot-v1-128k',
        },
        label: t.sKimiModel,
        description: t.sKimiModelDesc,
      },
      'kimiWebSearch': {
        section: 'joplinAide', type: SETTING_BOOL, value: true, public: true,
        label: t.sKimiWebSearch,
        description: t.sKimiWebSearchDesc,
      },
      'kimiShowReasoning': {
        section: 'joplinAide', type: SETTING_BOOL, value: true, public: true,
        label: t.sKimiShowReasoning,
        description: t.sKimiShowReasoningDesc,
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
      // Codex speaks JSON-RPC to `codex app-server`. The plugin never writes
      // the user's ~/.codex config: model and effort ride each request.
      'codexPath': {
        section: 'joplinAide', type: SETTING_STRING, value: '', public: true,
        subType: 'file_path',
        label: t.sCodexPath,
        description: t.sCodexPathDesc,
      },
      'codexModel': {
        section: 'joplinAide', type: SETTING_STRING, value: '', public: true,
        label: t.sCodexModel,
        description: t.sCodexModelDesc,
      },
      'codexEffort': {
        section: 'joplinAide', type: SETTING_STRING, value: '', public: true,
        isEnum: true,
        options: { '': 'Default', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high' },
        label: t.sCodexEffort,
        description: t.sCodexEffortDesc,
      },
      // Defaults mirror the Claude backend's WebSearch,WebFetch,Read: file
      // reads (attachments) pass without a card, and live web search is on.
      'codexAllowTools': {
        section: 'joplinAide', type: SETTING_STRING, value: 'shell(cat),shell(Get-Content),shell(type)', public: true,
        label: t.sCodexTools,
        description: t.sCodexToolsDesc,
      },
      'codexExtraArgs': {
        section: 'joplinAide', type: SETTING_STRING, value: '-c web_search=live', public: true,
        label: t.sCodexArgs,
        description: t.sCodexArgsDesc,
      },
      // Antigravity (agy) has no per-run permission flags: headless mode
      // soft-denies anything not pre-allowed in the user's own settings.json,
      // so tool grants live there (see ensureAntigravityPermission).
      'antigravityPath': {
        section: 'joplinAide', type: SETTING_STRING, value: '', public: true,
        subType: 'file_path',
        label: t.sAgyPath,
        description: t.sAgyPathDesc,
      },
      'antigravityModel': {
        section: 'joplinAide', type: SETTING_STRING, value: '', public: true,
        label: t.sAgyModel,
        description: t.sAgyModelDesc,
      },
      'antigravityAllowTools': {
        section: 'joplinAide', type: SETTING_STRING, value: 'read_url(*)', public: true,
        label: t.sAgyTools,
        description: t.sAgyToolsDesc,
      },
      'antigravityExtraArgs': {
        section: 'joplinAide', type: SETTING_STRING, value: '', public: true,
        label: t.sAgyArgs,
        description: t.sAgyArgsDesc,
      },
      // Not user-facing: the permission rules the plugin last wrote into the
      // user's agy settings.json, so a rule removed from antigravityAllowTools
      // can be taken back out without touching rules the user added by hand.
      'antigravityManagedRules': {
        section: 'joplinAide', type: SETTING_STRING, value: '', public: false,
        label: 'Antigravity rules managed by Aide',
      },
      'memoryEnabled': {
        section: 'joplinAide', type: SETTING_BOOL, value: false, public: true,
        label: t.sMemory,
        description: t.sMemoryDesc,
      },
      'memoryNoteId': {
        section: 'joplinAide', type: SETTING_STRING, value: '', public: true, advanced: true,
        label: t.sMemoryNote,
        description: t.sMemoryNoteDesc,
      },
      'memoryAutoApprove': {
        section: 'joplinAide', type: SETTING_BOOL, value: true, public: true, advanced: true,
        label: t.sMemoryAuto,
        description: t.sMemoryAutoDesc,
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
      '      <option value="codex">Codex</option>',
      '      <option value="antigravity">Antigravity</option>',
      '      <option value="kimi">Kimi</option>',
      '    </select>',
      '    <button id="cc-history" title="' + escapeHtml(t.titleHistory) + '">&#x1F550;</button>',
      '    <button id="cc-new" title="' + escapeHtml(t.titleNew) + '">&#x2795;</button>',
      '  </div>',
      '  <div id="cc-messages"></div>',
      // Sibling of the message list, not a child: CSS shows it only while
      // #cc-messages is :empty, so no JS has to track the transition.
      '  <div id="cc-empty">' + escapeHtml(t.emptyHint) + '</div>',
      '  <div id="cc-confirm"></div>',
      '  <div id="cc-attachments"></div>',
      '  <div id="cc-privacy" style="display:none;"><span>' + escapeHtml(t.privacyNotice) + '</span>',
      '    <button id="cc-privacy-x" type="button">' + escapeHtml(t.privacyDismiss) + '</button>',
      '  </div>',
      '  <div class="cc-input-row">',
      '    <textarea id="cc-input" rows="3" placeholder="' + escapeHtml(t.inputPlaceholder) + '"></textarea>',
      '    <div class="cc-input-buttons">',
      '      <button id="cc-attach" title="' + escapeHtml(t.titleAttach) + '">&#x1F4CE;</button>',
      '      <input id="cc-file" type="file" multiple style="display:none;" />',
      '      <button id="cc-send" title="' + escapeHtml(t.titleSend) + '">'
        + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>',
      '      <button id="cc-stop" title="' + escapeHtml(t.titleStop) + '" style="display:none;">'
        + '<svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="2" fill="currentColor"/></svg></button>',
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
        name: 'read_attachment',
        description: 'Read the CONTENT of a note attachment by its id (from list_note_attachments). Returns extracted text for PDF/Word/Excel/PowerPoint, plain text and code files. Use this to actually read an attachment when you cannot open its local_path with a file tool.',
        inputSchema: { type: 'object', properties: { attachment_id: { type: 'string', description: 'Attachment/resource id (the "id" field from list_note_attachments)' } }, required: ['attachment_id'] },
      },
      {
        name: 'create_attachment',
        description: 'Create a file from text content and attach it to a note. Use for text-based files you can author: Markdown, CSV, JSON, SVG, HTML, code, plain text. The file becomes a Joplin resource and a link (an image embed for SVG/image extensions) is appended to the note body. Cannot produce real binary files (PNG/JPG/PDF/xlsx) - those cannot be generated from text.',
        write: true,
        confirmSummary: (a) => fmt(t.cCreateAttachment, { name: a.filename || 'file', id: a.note_id }),
        inputSchema: {
          type: 'object',
          properties: {
            note_id: { type: 'string', description: 'Note to attach the file to' },
            filename: { type: 'string', description: 'File name including extension, e.g. data.csv, chart.svg, notes.md' },
            content: { type: 'string', description: 'The full text content of the file' },
          },
          required: ['note_id', 'filename', 'content'],
        },
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

    /* ---------- long-term memory (a regular Joplin note) ---------- */
    // The memory note is injected into the system prompt each session and the
    // AI updates it with the note tools it already has - no new plumbing.
    // Stored as a note so it is visible, editable and synced like anything else.
    let memoryNoteId = '';
    const MEMORY_MAX_CHARS = 4000;

    async function resolveMemoryNote(): Promise<{ id: string; body: string } | null> {
      if ((await joplin.settings.value('memoryEnabled')) !== true) { memoryNoteId = ''; return null; }
      let id = String((await joplin.settings.value('memoryNoteId')) || '').trim();
      if (id) {
        try {
          const n = await joplin.data.get(['notes', id], { fields: ['id', 'body'] });
          if (n) { memoryNoteId = id; return { id, body: String(n.body || '') }; }
        } catch (_) { /* note deleted - recreate below */ }
      }
      try {
        const created = await joplin.data.post(['notes'], null, {
          title: 'Aide Memory',
          body: '<!-- Joplin Aide long-term memory. The AI appends facts and preferences here; edit or prune freely. -->\n',
        });
        id = String(created.id);
        await joplin.settings.setValue('memoryNoteId', id);
        memoryNoteId = id;
        return { id, body: String(created.body || '') };
      } catch (_) { memoryNoteId = ''; return null; }
    }

    async function executeTool(name: string, args: any): Promise<{ result: any; isError?: boolean }> {
      const def = toolDefs.find((d) => d.name === name);
      if (!def) return { result: 'Unknown tool: ' + name, isError: true };

      if (def.write) {
        // Memory-note updates skip the approval card (opt-out setting) so
        // remembering things stays frictionless. Deletion still asks.
        const isMemoryWrite = !!memoryNoteId && args && args.note_id === memoryNoteId
          && name !== 'delete_note'
          && (await joplin.settings.value('memoryAutoApprove')) !== false;
        const needConfirm = (await joplin.settings.value('requireWriteConfirm')) !== false && !isMemoryWrite;
        if (needConfirm) {
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
        case 'read_attachment': {
          let res: any;
          try { res = await joplin.data.get(['resources', args.attachment_id], { fields: ['id', 'title', 'mime', 'file_extension', 'size'] }); }
          catch (_) { return { result: 'Attachment not found: ' + args.attachment_id, isError: true }; }
          const p = nodePath.join(getResourcesDir(), res.id + (res.file_extension ? '.' + res.file_extension : ''));
          if (!nodeFs.existsSync(p)) return { result: 'Attachment file not on disk (may not be synced yet): ' + p, isError: true };
          const buf = nodeFs.readFileSync(p);
          const s = buf.toString('utf8');
          const isImage = /^image\//.test(String(res.mime || ''));
          // Small clean text: return as-is. Otherwise use Moonshot file-extract
          // (works for the Kimi backend; CLI backends can Read the local_path).
          if (!isImage && buf.length < 100000 && s.indexOf('�') < 0) return { result: s };
          const kimiKey = String((await joplin.settings.value('kimiApiKey')) || '').trim();
          const kimiBase = String((await joplin.settings.value('kimiBaseUrl')) || '').trim() || 'https://api.moonshot.cn/v1';
          if (kimiKey) {
            try {
              const extracted = await kimiExtractFile(kimiBase, kimiKey, p, res.title || ('file' + (res.file_extension ? '.' + res.file_extension : '')));
              return { result: extracted };
            } catch (e: any) {
              return { result: 'Could not extract this attachment (' + String(e && e.message ? e.message : e) + '). Local path: ' + p, isError: true };
            }
          }
          return { result: 'This attachment is binary/an image. Local path: ' + p + ' - use the Read tool to view it.' };
        }
        case 'create_attachment': {
          const rawName = String(args.filename || 'file.txt');
          const safeName = (rawName.replace(/[^\w.\-一-鿿]+/g, '_').slice(0, 100)) || 'file.txt';
          const content = String(args.content == null ? '' : args.content);
          if (content.length > 5 * 1024 * 1024) return { result: 'Content too large (max 5 MB).', isError: true };
          const tmpPath = nodePath.join(attachmentsDir, 'gen-' + Date.now() + '-' + safeName);
          try {
            nodeFs.writeFileSync(tmpPath, content, 'utf8');
            const resource = await joplin.data.post(['resources'], null, { title: safeName }, [{ path: tmpPath }]);
            const ext = (safeName.split('.').pop() || '').toLowerCase();
            const isImg = /^(svg|png|jpe?g|gif|webp|bmp)$/.test(ext);
            const link = (isImg ? '!' : '') + '[' + safeName + '](:/' + resource.id + ')';
            let embedded = false;
            try {
              const cur = await joplin.data.get(['notes', args.note_id], { fields: ['body'] });
              const joined = String(cur.body || '').replace(/\s+$/, '') + '\n\n' + link + '\n';
              await joplin.data.put(['notes', args.note_id], null, { body: joined });
              embedded = true;
            } catch (_) { /* note missing - resource still created */ }
            post({ name: 'toolDone', text: fmt(t.dAttached, { name: safeName }) });
            return { result: { resource_id: resource.id, title: safeName, embedded_in_note: embedded ? args.note_id : null } };
          } catch (e: any) {
            return { result: 'Failed to create attachment: ' + String(e && e.message ? e.message : e), isError: true };
          } finally {
            try { nodeFs.unlinkSync(tmpPath); } catch (_) {}
          }
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
    // Clean up the temporary session-diagnostic log left by the debug build.
    try { nodeFs.unlinkSync(nodePath.join(dataDir, 'aide-session.log')); } catch (_) {}

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
    // Antigravity reads MCP servers from <workspace>/.agents/mcp_config.json.
    // The plugin runs agy with its own throwaway workspace so this file, and
    // anything the agent writes with its file tools, never touches a user
    // project. Global config (~/.gemini/config/mcp_config.json) is left alone.
    const agyWorkspaceDir = nodePath.join(dataDir, 'antigravity-workspace');
    try {
      nodeFs.mkdirSync(nodePath.join(agyWorkspaceDir, '.agents'), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(agyWorkspaceDir, '.agents', 'mcp_config.json'), JSON.stringify({
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
    } catch (err) { console.error('Joplin Aide: failed to write the Antigravity workspace', err); }

    // Headless agy cannot ask, and unconfigured MCP tools default to Ask, so
    // the Joplin tools must be pre-allowed in the user's agy settings. This
    // keeps permissions.allow in sync with the rules Aide owns: mcp(joplin/*)
    // plus the "additional allowed tools" setting. Rules Aide wrote earlier
    // but no longer wants are removed; anything the user added by hand is
    // left alone. The file is created if it does not exist yet.
    async function ensureAntigravityPermission(extraRules: string[]): Promise<void> {
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const file = nodePath.join(home, '.gemini', 'antigravity-cli', 'settings.json');
      const wanted = ['mcp(joplin/*)'].concat(extraRules).filter((r, i, all) => all.indexOf(r) === i);
      let managed: string[] = [];
      try { managed = JSON.parse(String((await joplin.settings.value('antigravityManagedRules')) || '[]')); } catch (_) { managed = []; }
      if (!Array.isArray(managed)) managed = [];
      let settings: any = {};
      try { settings = JSON.parse(nodeFs.readFileSync(file, 'utf8')); } catch (_) { /* absent or unreadable: start empty */ }
      if (!settings || typeof settings !== 'object') settings = {};
      if (!settings.permissions || typeof settings.permissions !== 'object') settings.permissions = {};
      if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
      const before = settings.permissions.allow.slice();
      const stale = managed.filter((r) => wanted.indexOf(r) < 0);
      let allow: string[] = before.filter((r: string) => stale.indexOf(r) < 0);
      for (const r of wanted) if (allow.indexOf(r) < 0) allow.push(r);
      if (JSON.stringify(allow) !== JSON.stringify(before)) {
        settings.permissions.allow = allow;
        nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
        nodeFs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
      }
      if (JSON.stringify(managed) !== JSON.stringify(wanted)) {
        await joplin.settings.setValue('antigravityManagedRules', JSON.stringify(wanted));
      }
    }

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
    let startingRequest = false;
    let requestGeneration = 0;
    let stopCodex: (() => void) | null = null;
    let sessionId: string = '';
    // Which backend the RUNNING child belongs to (event formats differ).
    let runBackend: string = 'claude';
    // Antigravity: whether the running process has emitted its init event
    // (it exits before init on an unknown --conversation id).
    let agyInitSeen = false;
    // Backend that OWNS the current sessionId. Ids don't transfer between
    // CLIs, so any mismatch - switching engines mid-chat, or loading a
    // conversation recorded on the other engine - must start fresh instead
    // of feeding a foreign id to --resume ("No session matched" errors).
    let sessionBackend: string = '';

    // Kimi runs an in-process API loop instead of a child process. These track
    // the in-flight HTTP request so the Stop button can abort it, and mark the
    // turn as busy for the concurrency/ready checks that used to key off `child`.
    let apiInFlight = false;
    let apiReq: any = null;
    let apiAborted = false;

    // Force-stop the running request. On Windows child.kill() only terminates
    // the wrapper shell - taskkill /T /F takes the whole process tree down so
    // the claude process (and its MCP proxy) cannot survive the stop button.
    function killChild(): void {
      requestGeneration++;
      if (apiInFlight) apiAborted = true;
      if (stopCodex) { const stop = stopCodex; stopCodex = null; stop(); return; }
      // Abort the Kimi API request, if one is streaming.
      if (apiReq) {
        apiAborted = true;
        try { apiReq.destroy(); } catch (_) {}
        apiReq = null;
      }
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

    // Defense for anything that rides the command line through shell:true:
    // cmd.exe truncates at the first newline, silently dropping every later
    // flag (verified with an argv probe - that's how a multi-line memory
    // injection ate --resume). Never let a newline reach an argument.
    function flattenShellArg(s: string): string {
      return String(s).replace(/\s*\r?\n+\s*/g, ' ');
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

    /* ---------- Kimi: in-process OpenAI-compatible engine ---------- */
    // Tools the API model may call. approval_prompt is a CLI permission bridge
    // with no meaning here - executeTool runs the confirm cards directly.
    // Drop past $web_search plumbing from a stored thread before resending it.
    // Moonshot ties web results to an ephemeral search_id; replaying a stale one
    // (especially to another model, e.g. kimi-k3) fails with "tokenization
    // failed". The model's final answer text is kept; only the search turn and
    // its echoed result are removed.
    function stripWebSearchHistory(messages: any[]): any[] {
      const webIds: { [id: string]: boolean } = {};
      const out: any[] = [];
      for (const m of messages) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
          const webCalls = m.tool_calls.filter((tc: any) => tc.function && tc.function.name === '$web_search');
          if (webCalls.length) {
            for (const tc of webCalls) webIds[tc.id] = true;
            const others = m.tool_calls.filter((tc: any) => !(tc.function && tc.function.name === '$web_search'));
            if (others.length) out.push(Object.assign({}, m, { tool_calls: others }));
            // pure web-search turn -> drop it whole (its content is just filler)
            continue;
          }
        }
        if (m.role === 'tool' && (m.name === '$web_search' || webIds[m.tool_call_id])) continue;
        out.push(m);
      }
      return out;
    }

    const KIMI_TOOL_EXCLUDE: { [k: string]: boolean } = { approval_prompt: true };
    function kimiToolSpecs(): any[] {
      return toolDefs
        .filter((d) => !KIMI_TOOL_EXCLUDE[d.name])
        .map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.inputSchema } }));
    }

    // Minimal raw HTTP helper for the Kimi file endpoints (multipart upload,
    // content retrieval, delete). Returns the status and raw body buffer.
    function kimiRaw(method: string, urlStr: string, apiKey: string, extraHeaders: any, bodyBuf: any):
      Promise<{ status: number; buf: any }> {
      return new Promise((resolve, reject) => {
        let url: any;
        try { url = new URL(urlStr); } catch (_) { reject(new Error('Bad URL: ' + urlStr)); return; }
        const mod = url.protocol === 'http:' ? nodeHttp : nodeHttps;
        const headers: any = Object.assign({ 'Authorization': 'Bearer ' + apiKey }, extraHeaders || {});
        if (bodyBuf) headers['Content-Length'] = bodyBuf.length;
        const req = mod.request({
          method, hostname: url.hostname, port: url.port || (url.protocol === 'http:' ? 80 : 443),
          path: url.pathname + url.search, headers,
        }, (res: any) => {
          const ch: any[] = [];
          res.on('data', (c: any) => ch.push(c));
          res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(ch) }));
          res.on('error', reject);
        });
        req.on('error', reject);
        if (bodyBuf) req.write(bodyBuf);
        req.end();
      });
    }

    // Moonshot file-extract: upload a file, fetch the server-extracted text,
    // then delete the file (best effort). Handles PDF/Word/Excel/PPT/etc.
    async function kimiExtractFile(baseUrl: string, apiKey: string, filePath: string, fileName: string): Promise<string> {
      const base = baseUrl.replace(/\/+$/, '');
      const fileBuf = nodeFs.readFileSync(filePath);
      const boundary = '----JoplinAide' + Date.now();
      const pre = Buffer.from(
        '--' + boundary + '\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nfile-extract\r\n'
        + '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="'
        + fileName.replace(/["\r\n]/g, '') + '"\r\nContent-Type: application/octet-stream\r\n\r\n', 'utf8');
      const tail = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8');
      const body = Buffer.concat([pre, fileBuf, tail]);
      const up = await kimiRaw('POST', base + '/files', apiKey, { 'Content-Type': 'multipart/form-data; boundary=' + boundary }, body);
      if (up.status >= 400) throw new Error('upload HTTP ' + up.status + ': ' + up.buf.toString('utf8').slice(0, 200));
      let id = '';
      try { id = JSON.parse(up.buf.toString('utf8')).id; } catch (_) {}
      if (!id) throw new Error('no file id in upload response');
      const ct = await kimiRaw('GET', base + '/files/' + id + '/content', apiKey, {}, null);
      kimiRaw('DELETE', base + '/files/' + id, apiKey, {}, null).catch(() => {}); // cleanup, don't wait
      if (ct.status >= 400) throw new Error('extract HTTP ' + ct.status);
      const raw = ct.buf.toString('utf8');
      try { const j = JSON.parse(raw); if (j && typeof j.content === 'string') return j.content; } catch (_) {}
      return raw;
    }

    // Build the user message content. Images ride as base64 data URLs (Kimi k3 /
    // k2.7 / k2.6 accept image input); small text files are inlined; other files
    // (PDF/Word/Excel/... or large/binary) go through Moonshot file-extract so
    // the model can actually read them. Returns a plain string when no images.
    async function kimiUserContent(text: string, baseUrl: string, apiKey: string): Promise<any> {
      if (!pendingAttachments.length) return text;
      let textPart = text;
      const imageParts: any[] = [];
      const imgExt = /\.(png|jpe?g|gif|webp)$/i;
      for (const a of pendingAttachments) {
        try {
          if (imgExt.test(a.fileName)) {
            const buf = nodeFs.readFileSync(a.filePath);
            const mime = /\.png$/i.test(a.fileName) ? 'image/png'
              : /\.gif$/i.test(a.fileName) ? 'image/gif'
              : /\.webp$/i.test(a.fileName) ? 'image/webp' : 'image/jpeg';
            imageParts.push({ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + buf.toString('base64') } });
            continue;
          }
          const buf = nodeFs.readFileSync(a.filePath);
          const s = buf.toString('utf8');
          if (buf.length < 100000 && s.indexOf('�') < 0) {
            textPart += '\n\n[Attached file ' + a.fileName + ']:\n```\n' + s + '\n```';
          } else {
            // PDF / Office / large / binary -> Moonshot server-side extraction.
            post({ name: 'toolUse', tool: 'read_attachment' });
            try {
              const extracted = await kimiExtractFile(baseUrl, apiKey, a.filePath, a.fileName);
              textPart += '\n\n[Attached file ' + a.fileName + ' (extracted content)]:\n' + extracted;
            } catch (e: any) {
              textPart += '\n\n[Attached file ' + a.fileName + ' - could not be read: ' + String(e && e.message ? e.message : e) + ']';
            }
          }
        } catch (_) { /* skip unreadable */ }
      }
      if (!imageParts.length) return textPart;
      return [{ type: 'text', text: textPart }].concat(imageParts);
    }

    // POST /chat/completions with stream:true, reassembling text and tool_call
    // deltas from the SSE stream. onDelta streams text tokens to the live bubble.
    function kimiStream(baseUrl: string, apiKey: string, payload: any, onDelta: (t: string) => void, onReasoning: (t: string) => void):
      Promise<{ content: string; toolCalls: { id: string; name: string; args: string; type: string }[]; finish: string }> {
      return new Promise((resolve, reject) => {
        let url: any;
        try { url = new URL(baseUrl.replace(/\/+$/, '') + '/chat/completions'); }
        catch (_) { reject(new Error('Bad Kimi endpoint: ' + baseUrl)); return; }
        const body = JSON.stringify(payload);
        const mod = url.protocol === 'http:' ? nodeHttp : nodeHttps;
        const req = mod.request({
          method: 'POST',
          hostname: url.hostname,
          port: url.port || (url.protocol === 'http:' ? 80 : 443),
          path: url.pathname + url.search,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
            'Content-Length': Buffer.byteLength(body),
          },
        }, (res: any) => {
          if (res.statusCode >= 400) {
            const ec: any[] = [];
            res.on('data', (c: any) => ec.push(c));
            res.on('end', () => reject(new Error('HTTP ' + res.statusCode + ': ' + Buffer.concat(ec).toString('utf8').slice(0, 600))));
            return;
          }
          res.setEncoding('utf8');
          let buf = '';
          let content = '';
          let finish = '';
          const acc: { [i: number]: { id: string; name: string; args: string; type: string } } = {};
          res.on('data', (chunk: string) => {
            buf += chunk;
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              let line = buf.slice(0, nl); buf = buf.slice(nl + 1);
              if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1); // strip trailing \r
              if (line.indexOf('data:') !== 0) continue;
              const data = line.slice(5).trim();
              if (!data || data === '[DONE]') continue;
              let ev: any;
              try { ev = JSON.parse(data); } catch (_) { continue; }
              const ch = ev.choices && ev.choices[0];
              if (!ch) continue;
              const delta = ch.delta || {};
              // Reasoning models (kimi-k3) stream their chain-of-thought in
              // reasoning_content before the actual answer arrives in content.
              if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) onReasoning(delta.reasoning_content);
              if (typeof delta.content === 'string' && delta.content) { content += delta.content; onDelta(delta.content); }
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const i = typeof tc.index === 'number' ? tc.index : 0;
                  if (!acc[i]) acc[i] = { id: '', name: '', args: '', type: '' };
                  if (tc.id) acc[i].id = tc.id;
                  if (tc.type) acc[i].type = tc.type;
                  if (tc.function) {
                    if (tc.function.name) acc[i].name += tc.function.name;
                    if (typeof tc.function.arguments === 'string') acc[i].args += tc.function.arguments;
                  }
                }
              }
              if (ch.finish_reason) finish = ch.finish_reason;
            }
          });
          res.on('end', () => {
            const toolCalls = Object.keys(acc).map(Number).sort((a, b) => a - b).map((i) => acc[i]);
            resolve({ content, toolCalls, finish });
          });
          res.on('error', (e: any) => reject(e));
        });
        req.on('error', (e: any) => reject(e));
        apiReq = req;
        req.write(body);
        req.end();
      });
    }

    async function runKimiApi(userText: string): Promise<void> {
      apiInFlight = true;
      apiAborted = false;
      let sawError = false;
      post({ name: 'busy', busy: true });
      try {
        const baseUrl = String((await joplin.settings.value('kimiBaseUrl')) || '').trim() || 'https://api.moonshot.cn/v1';
        const apiKey = String((await joplin.settings.value('kimiApiKey')) || '').trim();
        const model = String((await joplin.settings.value('kimiModel')) || '').trim() || 'kimi-k3';
        if (!apiKey) { post({ name: 'error', text: t.errKimiKey }); sawError = true; return; }

        // Switching in from a CLI backend: ids don't carry over. The API thread
        // lives on the conversation (apiMessages), so nothing else to reset.
        sessionBackend = 'kimi';

        let noteContext = '';
        try {
          const sel = await joplin.workspace.selectedNote();
          if (sel) noteContext = ' The note currently open in the editor is "' + sel.title + '" (id: ' + sel.id + ').';
        } catch (_) {}

        let memoryPrompt = '';
        const mem = await resolveMemoryNote();
        if (mem) {
          let memBody = mem.body.trim();
          if (memBody.length > MEMORY_MAX_CHARS) memBody = memBody.slice(0, MEMORY_MAX_CHARS) + '\n[memory truncated - consolidate this note]';
          memoryPrompt = ' PERSISTENT MEMORY: note ' + mem.id + ' is your long-term memory across all conversations. '
            + 'When the user asks you to remember something, or you confirm a stable preference or fact worth keeping, append a single concise bullet to that note (append_to_note). '
            + 'When it grows long or redundant, consolidate it with update_note. Keep entries terse; never store secrets. '
            + (memBody ? 'Current memory:\n' + memBody : 'The memory note is currently empty.');
        }

        const systemPrompt = 'You are embedded in the Joplin note-taking app as an assistant. '
          + 'Use the provided Joplin tools to read, search, create and edit the user\'s notes and notebooks. '
          + 'Note bodies are Markdown. Updating a note replaces the FULL body: read the note first, apply your change to the complete text, then send the entire new body - never a fragment, diff or patch. '
          + 'Write operations may require user approval; if one is declined, do not retry it. '
          + 'To read a note\'s attachment (PDF, Word, Excel, PowerPoint, text, code...), call list_note_attachments then read_attachment with the attachment id. '
          + 'To ask the user a multiple-choice question, use the ask_user tool - it renders clickable buttons in the panel and waits for the answer. '
          + 'Reply in the language the user writes in.'
          + noteContext + memoryPrompt;

        const userContent = await kimiUserContent(userText, baseUrl, apiKey);
        if (pendingAttachments.length) { pendingAttachments = []; post({ name: 'attachmentsCleared' }); }

        record('user', userText);
        if (currentConv) currentConv.backend = 'kimi';

        // Raw API message thread lives on the conversation. Rebuild from display
        // history if absent (e.g. a conversation started on another backend).
        let msgs: any[] = (currentConv && Array.isArray(currentConv.apiMessages)) ? currentConv.apiMessages.slice() : [];
        if (!msgs.length && currentConv && Array.isArray(currentConv.messages)) {
          for (const m of currentConv.messages) {
            if (m.role === 'user') msgs.push({ role: 'user', content: m.text });
            else if (m.role === 'assistant') msgs.push({ role: 'assistant', content: m.text });
          }
          // The user turn just recorded is re-added below as structured content.
          if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs.pop();
        }
        msgs = msgs.filter((m) => m.role !== 'system');
        msgs = stripWebSearchHistory(msgs); // remove stale $web_search plumbing
        msgs.unshift({ role: 'system', content: systemPrompt });
        msgs.push({ role: 'user', content: userContent });

        const tools = kimiToolSpecs();
        // Moonshot's server-side web search: declared as a builtin_function, the
        // model triggers it and executes it internally - the client only echoes
        // the tool-call arguments back verbatim (billed per triggered search).
        const webSearchOn = (await joplin.settings.value('kimiWebSearch')) === true;
        if (webSearchOn) tools.push({ type: 'builtin_function', function: { name: '$web_search' } });

        // Reasoning models (kimi-k3) always produce chain-of-thought; this only
        // controls whether it is shown in the panel.
        const showReasoning = (await joplin.settings.value('kimiShowReasoning')) !== false;

        // Stable key so Moonshot reuses the automatic context cache across the
        // turns of one conversation (big input-cost savings on long threads).
        const cacheKey = currentConv ? String(currentConv.id) : undefined;

        for (let round = 0; round < 25; round++) {
          if (apiAborted) break;
          let started = false;
          const onDelta = (txt: string) => {
            if (!started) { post({ name: 'assistantStart' }); started = true; }
            post({ name: 'assistantDelta', text: txt });
          };
          let startedReasoning = false;
          const onReasoning = (txt: string) => {
            if (!showReasoning) return;
            if (!startedReasoning) { post({ name: 'reasoningStart' }); startedReasoning = true; }
            post({ name: 'reasoningDelta', text: txt });
          };
          const payload: any = { model, messages: msgs, tools, tool_choice: 'auto', stream: true };
          if (cacheKey) payload.prompt_cache_key = cacheKey;
          const { content, toolCalls } = await kimiStream(baseUrl, apiKey, payload, onDelta, onReasoning);
          apiReq = null;
          if (apiAborted) break;

          // The image(s) have now been sent - replace the heavy base64 data URLs
          // in the thread with a placeholder so they are not resent every round
          // nor written into conversations.json (which would bloat to MBs).
          for (const m of msgs) {
            if (Array.isArray(m.content)) {
              m.content = m.content.map((p: any) => (p && p.type === 'image_url')
                ? { type: 'text', text: '[image sent earlier]' } : p);
            }
          }

          if (content) { record('assistant', content); post({ name: 'assistantText', text: content }); }
          toolCalls.forEach((tc, i) => { if (!tc.id) tc.id = 'call_' + round + '_' + i; });
          const asstMsg: any = { role: 'assistant', content: content ? content : null };
          if (toolCalls.length) {
            // Preserve the tool_call type - $web_search comes back as
            // "builtin_function"; echoing it as "function" makes Moonshot skip
            // injecting the search results (the search silently returns nothing).
            asstMsg.tool_calls = toolCalls.map((tc) => ({
              id: tc.id,
              type: tc.type || (tc.name === '$web_search' ? 'builtin_function' : 'function'),
              function: { name: tc.name, arguments: tc.args || '{}' },
            }));
          }
          msgs.push(asstMsg);
          if (!toolCalls.length) break;

          for (const tc of toolCalls) {
            // Builtin web search: Moonshot runs it; we return the arguments as-is.
            if (tc.name === '$web_search') {
              post({ name: 'toolUse', tool: 'web_search' });
              msgs.push({ role: 'tool', tool_call_id: tc.id, name: '$web_search', content: tc.args || '{}' });
              continue;
            }
            post({ name: 'toolUse', tool: tc.name });
            let argsObj: any = {};
            try { argsObj = tc.args ? JSON.parse(tc.args) : {}; } catch (_) {}
            const out = await executeTool(tc.name, argsObj);
            const resultStr = typeof out.result === 'string' ? out.result : JSON.stringify(out.result);
            msgs.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: resultStr });
          }
          if (apiAborted) break;
        }

        if (currentConv) { currentConv.apiMessages = msgs; saveHistory(); }
      } catch (err: any) {
        if (!apiAborted) {
          sawError = true;
          post({ name: 'error', text: String(err && err.message ? err.message : err).slice(0, 600) });
        }
      } finally {
        apiReq = null;
        apiInFlight = false;
        post({ name: 'turnDone', isError: sawError });
        post({ name: 'busy', busy: false });
      }
    }

    async function runClaude(prompt: string): Promise<void> {
      if (startingRequest || child || apiInFlight) {
        // Safety net (the webview also locks sending while busy). Reset the
        // webview's busy lock or it would stay disabled forever.
        post({ name: 'error', text: t.errAlreadyRunning });
        post({ name: 'busy', busy: true });
        return;
      }
      startingRequest = true;
      const generation = requestGeneration;
      post({ name: 'busy', busy: true });
      try {
        await startBackendTurn(prompt, generation);
      } catch (error: any) {
        post({ name: 'error', text: String(error?.message || error) });
      } finally {
        startingRequest = false;
        post({ name: 'busy', busy: !!child || apiInFlight });
      }
    }

    async function startBackendTurn(prompt: string, generation: number): Promise<void> {
      const backend = String((await joplin.settings.value('backend')) || 'claude');
      if (generation !== requestGeneration) return;
      // Kimi is served by the in-process OpenAI-compatible engine, not a CLI.
      if (backend === 'kimi') { await runKimiApi(prompt); return; }
      if (sessionId && sessionBackend && sessionBackend !== backend) { sessionId = ''; sessionAllowed = {}; }
      sessionBackend = backend;

      const extraArgs = String((await joplin.settings.value(
        backend === 'copilot' ? 'copilotExtraArgs' : (backend === 'antigravity' ? 'antigravityExtraArgs' : 'extraCliArgs'))) || '').trim();

      let noteContext = '';
      try {
        const sel = await joplin.workspace.selectedNote();
        if (sel) noteContext = ' The note currently open in the editor is "' + sel.title + '" (id: ' + sel.id + ').';
      } catch (_) {}

      // Long-term memory: current content rides the system prompt; the AI
      // maintains the note itself with the ordinary note tools.
      let memoryPrompt = '';
      const mem = await resolveMemoryNote();
      if (mem) {
        let memBody = mem.body.trim();
        if (memBody.length > MEMORY_MAX_CHARS) {
          memBody = memBody.slice(0, MEMORY_MAX_CHARS) + '\n[memory truncated - consolidate this note]';
        }
        // Newlines are flattened to bullets: on Windows this string ends up
        // inside a cmd.exe (shell:true) command line, and cmd truncates at
        // the first newline - silently dropping every LATER flag, including
        // --resume. That is exactly how enabling memory broke session
        // continuity in v1.1.6.
        const memFlat = memBody.replace(/\s*\r?\n+\s*/g, ' • ');
        memoryPrompt = ' PERSISTENT MEMORY: note ' + mem.id + ' is your long-term memory across all conversations. '
          + 'When the user asks you to remember something, or you confirm a stable preference or fact worth keeping, append a single concise bullet to that note (append_to_note). '
          + 'When it grows long or redundant, consolidate it with update_note. Keep entries terse; never store secrets. '
          + (memFlat ? 'Current memory (entries separated by •): ' + memFlat : 'The memory note is currently empty.');
      }

      const toolPrefix = (backend === 'copilot' || backend === 'antigravity') ? 'joplin MCP' : 'mcp__joplin';
      const systemPrompt = 'You are embedded in the Joplin note-taking app as an assistant. '
        + 'Use the ' + toolPrefix + ' tools to read, search, create and edit the user\'s notes and notebooks. '
        + 'Notes live in Joplin\'s database, NOT on disk: NEVER use file tools (Read/Edit/Write) or shell commands on a note, and never treat a note id or title as a file path. Every note operation goes through the ' + toolPrefix + ' tools - going file-first and correcting later wastes the user\'s time. '
        + 'Note bodies are Markdown. Updating a note replaces the FULL body: read the note first, apply your change to the complete text, then send the entire new body - never a fragment, diff or patch. '
        + 'Write operations may require user approval; if one is declined, do not retry it. '
        + 'To ask the user a multiple-choice question, use the ' + toolPrefix + ' ask_user tool - it renders clickable buttons in the panel and waits for the answer. '
        + 'Other question mechanisms do NOT work in this environment; never use them. '
        + 'Reply in the language the user writes in.'
        + noteContext
        + memoryPrompt;

      let bin: string;
      let args: string[];

      if (generation !== requestGeneration) return;
      if (backend === 'codex') {
        await runCodex(prompt, systemPrompt, generation);
        return;
      }
      if (backend === 'antigravity') {
        bin = String((await joplin.settings.value('antigravityPath')) || '').trim() || 'agy';
        // The Windows installer drops agy.exe in %LOCALAPPDATA%\agy\bin, which
        // is on the user's shell PATH but not necessarily on Joplin's.
        if (process.platform === 'win32' && bin === 'agy') {
          const installed = nodePath.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
          if (nodeFs.existsSync(installed)) bin = installed;
        }
        const model = await joplin.settings.value('antigravityModel');
        // Driver mode (agy >= 1.1.15): one NDJSON user event on stdin, events
        // on stdout, exit 0 once stdin closes and the turn is done. --print
        // would put the prompt on the command line instead. --add-dir makes
        // tools run in the workspace rather than agy's scratch dir, and
        // --disable-slash-commands keeps a "/..." prompt from ending the run.
        args = [
          '--input-format', 'stream-json',
          '--output-format', 'stream-json',
          '--disable-slash-commands',
          '--print-timeout', '30m',
          '--add-dir', winQuote(agyWorkspaceDir),
          '--add-dir', winQuote(attachmentsDir),
        ];
        // AUTO MODE parity (see the Copilot branch): headless agy has no
        // approval prompt, so this is the only way to lift its Ask rules.
        if ((await joplin.settings.value('autoApproveAll')) === true) {
          args.push('--dangerously-skip-permissions');
        }
        if (sessionId) { args.push('--conversation', sessionId); }
        if (model) { args.push('--model', winQuote(String(model))); }
        if (extraArgs) { args.push(extraArgs); }
        const allowRules = String((await joplin.settings.value('antigravityAllowTools')) || '')
          .split(',').map((s: string) => s.trim()).filter((s: string) => !!s);
        try { await ensureAntigravityPermission(allowRules); } catch (err: any) {
          post({ name: 'error', text: fmt(t.errAgySettings, { err: String(err && err.message ? err.message : err) }) });
        }
      } else if (backend === 'copilot') {
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
          '--append-system-prompt', winQuote(flattenShellArg(systemPrompt)),
        ];
        if (sessionId) { args.push('--resume', sessionId); }
        if (model) { args.push('--model', winQuote(String(model))); }
        if (extraArgs) { args.push(extraArgs); }
      }

      if (generation !== requestGeneration) return;
      if (!cliExists(bin)) {
        const installCmd = backend === 'copilot'
          ? 'npm install -g @github/copilot'
          : backend === 'antigravity'
            ? (process.platform === 'win32' ? 'irm https://antigravity.google/cli/install.ps1 | iex' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash')
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
          // Antigravity: the attachments dir is on --add-dir, so its file
          // tool can read them without a permission rule.
          const hint = backend === 'antigravity' ? 'Read them from disk:' : 'Use the Read tool to view them:';
          prompt += '\n\n[The user attached the following files. ' + hint + ']\n' + attachmentLines.join('\n');
        }
        pendingAttachments = [];
        post({ name: 'attachmentsCleared' });
      }
      record('user', prompt);
      // Copilot and Antigravity have no --append-system-prompt: context rides
      // at the top of the prompt itself (recorded history keeps the clean
      // user text above).
      if (backend === 'copilot' || backend === 'antigravity') {
        prompt = '<context>' + systemPrompt + '</context>\n\n' + prompt;
      }
      // agy's driver mode reads one JSON user event per line, not raw text.
      const stdinPayload = backend === 'antigravity'
        ? JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n'
        : prompt;
      agyInitSeen = false;
      runBackend = backend;
      post({ name: 'busy', busy: true });
      try {
        child = nodeChildProcess.spawn(winQuote(bin), args, {
          shell: process.platform === 'win32',
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          // agy treats its cwd as the project: keep it in the plugin's own
          // workspace so .agents/mcp_config.json is found and file tools
          // cannot touch a real project by accident.
          cwd: backend === 'antigravity' ? agyWorkspaceDir : undefined,
        });
      } catch (err: any) {
        post({ name: 'error', text: fmt(t.errStartFailed, { bin, err: String(err && err.message ? err.message : err) }) });
        post({ name: 'busy', busy: false });
        child = null;
        return;
      }

      child.stdin.write(stdinPayload);
      child.stdin.end();

      let stdoutBuf = '';
      const runningChild = child;
      const stderrChunks: any[] = [];
      child.stdout.on('data', (chunk: any) => {
        if (child !== runningChild) return;
        stdoutBuf += chunk.toString('utf8');
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (line) {
            if (runBackend === 'copilot') handleCopilotEvent(line);
            else if (runBackend === 'antigravity') handleAntigravityEvent(line);
            else handleClaudeEvent(line);
          }
        }
      });
      child.stderr.on('data', (chunk: any) => { stderrChunks.push(chunk); });
      child.on('error', (err: any) => {
        if (child !== runningChild) return;
        post({ name: 'error', text: fmt(t.errProcess, { bin, err: String(err && err.message ? err.message : err) }) });
        child = null;
        post({ name: 'busy', busy: startingRequest || apiInFlight });
      });
      child.on('close', (code: number) => {
        if (child !== runningChild) return;
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
        // agy dies before its init event when --conversation names a thread
        // it does not have (or auth failed); either way the next turn must
        // not carry that id again.
        if (runBackend === 'antigravity' && !agyInitSeen) {
          if (code !== 0 && !stderrText) post({ name: 'error', text: fmt(t.errExited, { bin, code, err: 'no output' }) });
          if (sessionId) { sessionId = ''; sessionBackend = ''; }
        }
        child = null;
        post({ name: 'busy', busy: startingRequest || apiInFlight });
      });
    }

    // Codex runs as `codex app-server` (JSON-RPC over stdio), one process per
    // turn like the other CLIs. The Joplin tools reach it through the same MCP
    // proxy; Codex asks the client before every MCP tool call, and those calls
    // are accepted here because Aide's own write tools already raise the
    // confirmation cards. Shell commands / file edits go through the cards.
    async function runCodex(prompt: string, instructions: string, generation: number): Promise<void> {
      let bin = String((await joplin.settings.value('codexPath')) || '').trim() || 'codex';
      if (generation !== requestGeneration) return;
      // Prefer the desktop app's native binary on Windows: npm installs a
      // .cmd launcher, and prompts must never pass through cmd.exe.
      if (process.platform === 'win32' && bin === 'codex') {
        const desktop = nodePath.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
        if (nodeFs.existsSync(desktop)) bin = desktop;
      }
      if (!cliExists(bin)) {
        post({ name: 'error', text: fmt(t.errCliMissing, { bin, cmd: 'npm install -g @openai/codex' }) });
        return;
      }
      const model = String((await joplin.settings.value('codexModel')) || '').trim();
      const effort = String((await joplin.settings.value('codexEffort')) || '').trim();
      const extraArgs = splitArgs(String((await joplin.settings.value('codexExtraArgs')) || ''));
      // Approvals granted without a card: "shell", "shell(git status)",
      // "write", "mcp(node_repl)". Same shape as Copilot's --allow-tool list,
      // except that everything NOT listed asks instead of being denied.
      const allowRules = String((await joplin.settings.value('codexAllowTools')) || '')
        .split(',').map((s: string) => s.trim()).filter((s: string) => !!s);
      const allowed = (kind: string, detail: string): boolean => allowRules.some((rule) => {
        const m = /^(\w+)(?:\((.*)\))?$/.exec(rule);
        return !!m && m[1] === kind && (!m[2] || detail.indexOf(m[2]) === 0);
      });
      if (generation !== requestGeneration) return;

      const input: any[] = [{ type: 'text', text: prompt }];
      for (const a of pendingAttachments) {
        if (/\.(png|jpe?g|webp|gif)$/i.test(a.fileName)) {
          input.push({ type: 'localImage', path: a.filePath });
        } else input[0].text += '\n[The user attached a file. Read it from disk:] ' + a.filePath;
      }
      runBackend = 'codex';
      record('user', prompt);
      pendingAttachments = [];
      post({ name: 'attachmentsCleared' });
      post({ name: 'busy', busy: true });

      let finished = false;
      let reasoningOpen = false;
      let lastError = '';
      let client: CodexClient;
      // The turn is over (completed, failed, or stopped). The panel stays busy
      // until the process has actually exited - see the 'close' handler.
      const finish = (error?: Error): void => {
        if (finished) return;
        finished = true;
        stopCodex = null;
        if (error) post({ name: 'error', text: String(error.message || error).slice(0, 1000) });
        post({ name: 'turnDone', isError: !!error });
        client.close();
      };
      const onRequest = (message: any): void => {
        const p = message.params || {};
        const reply = (result: any) => { if (!finished) client.send({ id: message.id, result }); };
        switch (message.method) {
          case 'mcpServer/elicitation/request': {
            // Per-call approval for MCP tools. Aide's own server needs no
            // second prompt; other servers from the user's Codex config get
            // a confirmation card like any other side effect.
            const meta = p._meta || {};
            if (meta.codex_approval_kind !== 'mcp_tool_call') { reply({ action: 'decline' }); return; }
            const server = String(p.serverName || '');
            if (server === 'joplin' || allowed('mcp', server)) { reply({ action: 'accept', content: {} }); return; }
            void requestConfirm('Codex: ' + String(p.message || server), 'codex:mcp:' + server)
              .then((ok) => reply(ok ? { action: 'accept', content: {} } : { action: 'decline' }));
            return;
          }
          case 'item/commandExecution/requestApproval': {
            // On Windows `command` is the powershell.exe wrapper line; the
            // user's actual command is in commandActions. Match rules and
            // label the card with the inner command.
            const inner = (p.commandActions || []).map((a: any) => String(a.command || '')).filter((s: string) => !!s);
            const command = inner.join(' ; ') || String(p.command || p.reason || 'command');
            if (inner.concat(String(p.command || '')).some((c: string) => allowed('shell', c))) { reply({ decision: 'accept' }); return; }
            void requestConfirm('Codex: ' + command, 'codex:' + message.method)
              .then((ok) => reply({ decision: ok ? 'accept' : 'decline' }));
            return;
          }
          case 'item/fileChange/requestApproval': {
            if (allowed('write', '')) { reply({ decision: 'accept' }); return; }
            void requestConfirm('Codex: ' + String(p.reason || p.grantRoot || 'file change'), 'codex:' + message.method)
              .then((ok) => reply({ decision: ok ? 'accept' : 'decline' }));
            return;
          }
          case 'item/permissions/requestApproval':
            // Extra sandbox permissions (network, writes outside cwd): not
            // something a note assistant needs. Grant nothing.
            reply({ permissions: {}, scope: 'turn' });
            return;
          case 'item/tool/requestUserInput': {
            // Codex's own question tool -> the panel's option buttons.
            // Free-text questions have no UI here; they get an empty answer.
            void (async () => {
              const answers: any = {};
              for (const q of (p.questions || [])) {
                const options = (q.options || []).map((o: any) => typeof o === 'string' ? o : String(o.label || '')).filter((s: string) => !!s);
                const a = options.length && !finished ? await requestAnswer(String(q.question || q.header || ''), options) : '';
                answers[q.id] = { answers: a ? [a] : [] };
              }
              reply({ answers });
            })();
            return;
          }
          default:
            if (!finished) client.send({ id: message.id, error: { code: -32601, message: 'Unsupported request: ' + message.method } });
        }
      };
      const onMessage = (message: any): void => {
        if (finished) return;
        if (message.id !== undefined && message.method) { onRequest(message); return; }
        const p = message.params || {};
        const item = p.item || {};
        switch (message.method) {
          case 'item/started':
            if (item.type === 'agentMessage') { reasoningOpen = false; post({ name: 'assistantStart' }); }
            else if (item.type === 'reasoning') { reasoningOpen = true; post({ name: 'reasoningStart' }); }
            else if (item.type === 'mcpToolCall' || item.type === 'commandExecution' || item.type === 'fileChange') {
              reasoningOpen = false;
              const tool = String(item.tool || item.command || item.type);
              record('tool', tool);
              post({ name: 'toolUse', tool });
            }
            break;
          case 'item/agentMessage/delta':
            if (p.delta) post({ name: 'assistantDelta', text: p.delta });
            break;
          case 'item/reasoning/summaryTextDelta':
            if (!reasoningOpen) { reasoningOpen = true; post({ name: 'reasoningStart' }); }
            if (p.delta) post({ name: 'reasoningDelta', text: p.delta });
            break;
          case 'item/reasoning/summaryPartAdded':
            if (reasoningOpen) post({ name: 'reasoningDelta', text: '\n\n' });
            break;
          case 'item/completed':
            if (item.type === 'agentMessage' && item.text) {
              record('assistant', item.text);
              post({ name: 'assistantText', text: item.text });
            }
            break;
          case 'error':
            // Turn-level errors; the failing turn/completed that follows may
            // carry no message of its own.
            if (!p.willRetry && p.error && p.error.message) lastError = String(p.error.message);
            break;
          case 'turn/completed': {
            const turn = p.turn || {};
            if (turn.status === 'failed') finish(new Error((turn.error && turn.error.message) || lastError || 'Codex turn failed'));
            else finish();
            break;
          }
        }
      };

      try {
        client = new CodexClient(bin, onMessage, (error) => finish(error), extraArgs);
      } catch (error: any) {
        post({ name: 'error', text: String(error && error.message ? error.message : error) });
        return;
      }
      child = client.process;
      client.process.on('close', () => {
        if (child !== client.process) return;
        child = null;
        post({ name: 'busy', busy: startingRequest || apiInFlight });
      });
      // Stop button / new session / rewind: drop open cards, kill the tree.
      stopCodex = () => {
        for (const id of Object.keys(pendingConfirms)) {
          const pending = pendingConfirms[id];
          clearTimeout(pending.timer); delete pendingConfirms[id];
          post({ name: 'confirmGone', requestId: id }); pending.resolve(false);
        }
        for (const id of Object.keys(pendingQuestions)) {
          const pending = pendingQuestions[id];
          clearTimeout(pending.timer); delete pendingQuestions[id];
          post({ name: 'questionGone', requestId: id });
          pending.resolve('Cancelled by user.');
        }
        if (finished) return;
        finished = true;
        stopCodex = null;
        post({ name: 'turnDone', isError: false });
        client.kill();
      };

      try {
        await client.request('initialize', { clientInfo: { name: 'joplin_aide', version: '1.3.2' } });
        if (finished) return;
        client.send({ method: 'initialized', params: {} });
        const params: any = {
          cwd: dataDir,
          // 'untrusted': only Codex's known-safe read commands run without
          // asking; everything else raises a card. Same footing as the Claude
          // backend, where every non-joplin tool goes through approval_prompt.
          approvalPolicy: 'untrusted',
          sandbox: 'read-only',
          developerInstructions: instructions,
          config: { 'mcp_servers.joplin': {
            command: process.execPath, args: [proxyPath],
            env: { ELECTRON_RUN_AS_NODE: '1', JOPLIN_AIDE_PORT: String(controlPort) },
            required: true, tool_timeout_sec: 180,
          } },
        };
        if (model) params.model = model;
        let result: any = null;
        if (sessionId) {
          try {
            result = await client.request('thread/resume', { ...params, threadId: sessionId, excludeTurns: true });
          } catch (error: any) {
            // Thread gone (cleaned ~/.codex, foreign id from history...):
            // say so and continue in a fresh thread instead of failing every
            // retry with the same error.
            if (finished) return;
            post({ name: 'error', text: fmt(t.codexResumeFailed, { err: String(error && error.message ? error.message : error).slice(0, 300) }) });
            sessionId = '';
            sessionAllowed = {};
          }
        }
        if (!result) result = await client.request('thread/start', params);
        if (finished) return;
        sessionId = String(result.thread.id);
        if (currentConv) { currentConv.sessionId = sessionId; currentConv.backend = 'codex'; saveHistory(); }
        const turnParams: any = { threadId: sessionId, input };
        if (effort) turnParams.effort = effort;
        await client.request('turn/start', turnParams);
      } catch (error: any) { finish(error); }
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

    // Antigravity CLI --output-format stream-json: NDJSON, one event per line.
    // init -> conversation id; step_update(agent_response) -> text deltas,
    // final text at DONE; step_update(tool) -> chips, permission denials as
    // ERROR frames; result -> turn end (+ denied_actions). Headless agy has
    // no approval prompt: a denial simply ends the turn with an empty reply.
    let agyText = '';
    let agyStreaming = false;
    let agyDenied: string[] = [];
    function handleAntigravityEvent(line: string): void {
      let ev: any;
      try { ev = JSON.parse(line); } catch (_) { return; }
      const adoptConversation = (id: any) => {
        if (!id || String(id) === sessionId) return;
        sessionId = String(id);
        if (currentConv) { currentConv.sessionId = sessionId; currentConv.backend = runBackend; saveHistory(); }
      };
      if (ev.event === 'init') {
        agyInitSeen = true;
        adoptConversation(ev.conversation_id);
        return;
      }
      if (ev.event === 'step_update') {
        const s = ev.step_update || {};
        if (s.step_type === 'agent_response') {
          const delta = typeof s.text_delta === 'string' ? s.text_delta : '';
          // Thinking-only steps end with a DONE that carries no text, or a
          // lone "\n": never open a bubble for those.
          if (delta && (agyStreaming || delta.trim())) {
            if (!agyStreaming) { agyStreaming = true; agyText = ''; post({ name: 'assistantStart' }); }
            agyText += delta;
            post({ name: 'assistantDelta', text: delta });
          }
          if (s.state === 'DONE' || s.state === 'ERROR') {
            if (agyStreaming && agyText.trim()) {
              record('assistant', agyText);
              post({ name: 'assistantText', text: agyText });
            }
            agyStreaming = false;
            agyText = '';
          }
        } else if (s.step_type === 'tool') {
          const info = s.tool_info || {};
          const params = info.parameters || {};
          // MCP calls arrive as the generic call_mcp_tool; the chip should
          // name the Joplin tool. Before calling one, agy view_file's its
          // own cached tool schema under ~/.gemini/antigravity-cli/mcp/ -
          // internal bookkeeping, not something to show.
          let name = String(s.tool_name || info.name || 'tool');
          if (name === 'call_mcp_tool' && params.ToolName) name = String(params.ToolName);
          if (name === 'view_file' && /[\\/]antigravity-cli[\\/]mcp[\\/]/.test(String(params.AbsolutePath || ''))) return;
          if (s.state === 'ACTIVE') {
            record('tool', name);
            post({ name: 'toolUse', tool: name });
          } else if (s.state === 'ERROR') {
            const msg = String((info.error && info.error.message) || '');
            if (/permission check failed|denied permission/i.test(msg)) agyDenied.push(name);
            else if (msg) post({ name: 'toolDone', text: '✗ ' + name + ': ' + msg.slice(0, 200) });
          }
        }
        return;
      }
      if (ev.event === 'result') {
        const r = ev.result || {};
        adoptConversation(r.conversation_id);
        let isError = false;
        if (r.status && r.status !== 'SUCCESS') {
          isError = true;
          post({ name: 'error', text: String(r.error || r.status).slice(0, 500) });
        }
        if (agyDenied.length) {
          // denied_actions is cumulative per process; the frames seen this
          // turn are what actually happened now.
          const what = agyDenied.filter((n, i) => agyDenied.indexOf(n) === i).join(', ');
          post({ name: 'error', text: fmt(t.errAgyDenied, { what }) });
          agyDenied = [];
        }
        agyStreaming = false;
        agyText = '';
        post({ name: 'turnDone', isError });
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
          post({ name: 'conversationLoaded', id: currentConv.id, messages: currentConv.messages, archiveSegments: currentConv.archiveSegments || 0, busy: startingRequest || !!child || apiInFlight });
        }
        post({ name: 'busy', busy: startingRequest || !!child || apiInFlight });
        post({ name: 'backendState', backend: String((await joplin.settings.value('backend')) || 'claude') });
        post({ name: 'privacyNotice', show: (await joplin.settings.value('privacyNoticeDismissed')) !== true });
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
      } else if (msg.name === 'dismissPrivacy') {
        await joplin.settings.setValue('privacyNoticeDismissed', true);
      } else if (msg.name === 'setBackend') {
        // Dropdown switch from the panel header. Takes effect on the next
        // message: runClaude reads the setting per turn, and the
        // lastBackend guard starts a fresh CLI session automatically.
        const next = ['copilot', 'codex', 'antigravity', 'kimi'].indexOf(msg.value) >= 0 ? msg.value : 'claude';
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
            currentConv.apiMessages = null; // rebuild the Kimi thread from the truncated history
            currentConv.updated = Date.now();
            currentConv.sessionId = '';
            sessionId = '';
            sessionBackend = '';
            sessionAllowed = {};
            saveHistory();
            post({ name: 'conversationLoaded', id: currentConv.id, messages: currentConv.messages, archiveSegments: currentConv.archiveSegments || 0, busy: startingRequest || !!child || apiInFlight });
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
          post({ name: 'conversationLoaded', id: conv.id, messages: conv.messages || [], archiveSegments: conv.archiveSegments || 0, busy: startingRequest || !!child || apiInFlight });
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
