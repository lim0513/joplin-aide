const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const root = path.join(__dirname, '..');

// Exercise the actual panel event handler with inert DOM rendering.
let receive;
const sent = [];
const context = vm.createContext({
  document: { getElementById: () => null, addEventListener() {}, querySelectorAll: () => [] },
  window: {}, navigator: {}, console,
  webviewApi: { postMessage: m => sent.push(m), onMessage: fn => { receive = fn; } },
});
vm.runInContext(fs.readFileSync(path.join(root, 'src/webview/panel.js'), 'utf8'), context);
vm.runInContext('endStreamBubble = endReasoning = scrollToBottom = renderHistoryChunk = attachMsgFooter = function() {}; addBubble = function() { return {}; };', context);
const event = message => receive({ message });
event({ name: 'busy', busy: true });
event({ name: 'turnDone' });
context.sendText('too soon');
assert.equal(context._busy, true, 'Final text must not unlock a still-running process');
assert.equal(sent.filter(m => m.name === 'send').length, 0);
event({ name: 'error', text: 'tool error' });
assert.equal(context._busy, true, 'An error message is not a process exit');
event({ name: 'conversationLoaded', id: 'test', messages: [], busy: true });
assert.equal(context._busy, true, 'Reload must preserve the host busy state');
event({ name: 'busy', busy: false });
context.sendText('next request');
assert.equal(sent.filter(m => m.name === 'send').length, 1);
assert.equal(context._busy, true, 'Sending locks immediately');

// Exercise the actual host entrypoint while startup is deliberately suspended.
const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
const start = source.indexOf('    async function runClaude(');
const end = source.indexOf('    async function startBackendTurn(', start);
const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
async function hostTest() {
  let release;
  let starts = 0;
  const messages = [];
  const host = vm.createContext({ startingRequest: false, requestGeneration: 0, child: null, apiInFlight: false,
    post: m => messages.push(m), t: { errAlreadyRunning: 'busy' },
    startBackendTurn: () => { starts++; return new Promise(resolve => { release = resolve; }); },
  });
  vm.runInContext(code, host);
  const first = host.runClaude('one');
  await host.runClaude('two');
  assert.equal(starts, 1, 'Startup must reject concurrent requests before spawning');
  assert.equal(host.startingRequest, true);
  release(); await first;
  assert.equal(host.startingRequest, false);
  assert.equal(messages.at(-1).busy, false);
  host.startBackendTurn = async () => { throw new Error('startup failed'); };
  await host.runClaude('three');
  assert.equal(host.startingRequest, false, 'Startup errors must release the lock');
  assert.equal(messages.at(-1).busy, false);
  console.log('PASS: final/error ordering, reload, send lock, concurrent startup and failure cleanup');
}
hostTest().catch(error => { console.error(error); process.exitCode = 1; });
