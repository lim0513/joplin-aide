// Drives the real handleAntigravityEvent from src/index.ts with archived agy
// 1.2.2 stream-json captures (scripts/fixtures/antigravity, recorded by the
// vicoa project on 2026-09-16) and checks the panel messages it produces.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.join(__dirname, '..');

const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
const start = source.indexOf("    let agyText = '';");
const end = source.indexOf('    await pushNoteContext();', start);
assert.ok(start > 0 && end > start, 'handleAntigravityEvent block not found');
const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

// Objects posted from inside the vm have that realm's prototypes; strip them.
const plain = (x) => JSON.parse(JSON.stringify(x));

function run(fixture) {
  const host = vm.createContext({
    sessionId: '', runBackend: 'antigravity', agyInitSeen: false, currentConv: { sessionId: '', backend: '' },
    messages: [], recorded: [],
    post: (m) => host.messages.push(m),
    record: (role, text) => host.recorded.push([role, text]),
    saveHistory: () => {},
    fmt: (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k])),
    t: { errAgyDenied: 'denied: {what}' },
  });
  vm.runInContext(code, host);
  const lines = fs.readFileSync(path.join(root, 'scripts/fixtures/antigravity', fixture), 'utf8').split('\n').filter(Boolean);
  for (const line of lines) host.handleAntigravityEvent(line);
  return host;
}

let h = run('tools_allowed.ndjson');
assert.equal(h.sessionId, '273b9d3e-dcbe-4711-baae-0c363553bce7', 'conversation id adopted from init');
assert.equal(h.currentConv.backend, 'antigravity');
assert.equal(h.agyInitSeen, true);
assert.deepEqual(h.messages.filter(m => m.name === 'toolUse').map(m => m.tool), ['run_command', 'write_to_file']);
assert.deepEqual(h.messages.filter(m => m.name === 'assistantText').map(m => m.text), ['done\n']);
assert.deepEqual(h.recorded.filter(r => r[0] === 'assistant').map(r => r[1]), ['done\n']);
assert.equal(h.messages.filter(m => m.name === 'error').length, 0);
assert.deepEqual(plain(h.messages.at(-1)), { name: 'turnDone', isError: false });
console.log('PASS: tools_allowed -> chips, final text, clean turn end');

// Captured from agy 1.2.5 on 2026-09-18 with the plugin's own launch flags and
// workspace mcp_config.json: the model reads its cached tool schema, then
// calls the Joplin tool through call_mcp_tool.
h = run('mcp_tool_call.ndjson');
assert.deepEqual(h.messages.filter(m => m.name === 'toolUse').map(m => m.tool), ['get_selected_note'], 'MCP chip named after the Joplin tool, schema lookups hidden');
const finals = h.messages.filter(m => m.name === 'assistantText').map(m => m.text);
assert.equal(finals.length, 1);
assert.match(finals[0], /pineapple/);
assert.equal(h.messages.filter(m => m.name === 'error').length, 0);
assert.ok(h.sessionId, 'conversation id adopted from init');
console.log('PASS: mcp_tool_call -> call_mcp_tool mapped to the Joplin tool name');

h = run('read_ok_write_denied.ndjson');
const denied = h.messages.filter(m => m.name === 'error');
assert.equal(denied.length, 1);
assert.match(denied[0].text, /write_to_file/);
assert.equal(h.messages.filter(m => m.name === 'assistantStart').length, 0, 'thinking-only steps open no bubble');
assert.deepEqual(plain(h.messages.at(-1)), { name: 'turnDone', isError: false });
console.log('PASS: permission denial surfaces as an error naming the tool');

h = run('text_then_denied_command.ndjson');
const turns = h.messages.filter(m => m.name === 'turnDone');
assert.equal(turns.length, 2, 'one turnDone per result');
assert.deepEqual(h.messages.filter(m => m.name === 'assistantDelta').map(m => m.text), ['pong', '\n']);
assert.deepEqual(h.messages.filter(m => m.name === 'assistantText').map(m => m.text), ['pong\n']);
const errors = h.messages.filter(m => m.name === 'error');
assert.equal(errors.length, 1, 'the denial in turn 2 is reported once');
assert.match(errors[0].text, /run_command/);
const firstTurnEnd = h.messages.findIndex(m => m.name === 'turnDone');
assert.ok(h.messages.indexOf(errors[0]) > firstTurnEnd, 'turn 1 ends clean; the denial belongs to turn 2');
console.log('PASS: streamed text then a denied command in the next turn');
