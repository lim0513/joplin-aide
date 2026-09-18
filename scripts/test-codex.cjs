const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const source = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/codex.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function load(childProcess, timers = { setTimeout, clearTimeout }) {
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => name === 'child_process' ? childProcess : require(name), process, ...timers });
  return exports.CodexClient;
}

async function test() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const sent = [];
  child.stdin.write = text => sent.push(JSON.parse(text));
  const events = []; const errors = [];
  const Client = load({ spawn: () => child });
  const client = new Client('test.exe', event => events.push(event), error => errors.push(error));
  const request = client.request('initialize', {});
  child.stdout.emit('data', Buffer.from(JSON.stringify({ id: sent[0].id, result: { ok: true } }) + '\n'));
  assert.equal((await request).ok, true);
  const notification = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '你好' } }) + '\n');
  for (const byte of notification) child.stdout.emit('data', Buffer.from([byte]));
  assert.equal(events[0].params.delta, '你好');
  const rejected = client.request('thread/resume', {});
  child.stdout.emit('data', Buffer.from(JSON.stringify({ id: sent[1].id, error: { message: 'missing thread' } }) + '\n'));
  await assert.rejects(rejected, /missing thread/);
  const pending = client.request('turn/start', {});
  child.emit('close', 1);
  await assert.rejects(pending, /Codex exited/);
  child.emit('error', new Error('duplicate'));
  assert.equal(errors.length, 1);
  assert.doesNotThrow(() => { client.kill(); client.close(); }, "kill/close after exit must be no-ops");
  console.log('PASS: RPC responses, errors, split UTF-8 streaming and disconnect cleanup');

  // Joplin's plugin sandbox can return numeric timer IDs, unlike Node.
  const numericClient = load({ spawn: () => child }, { setTimeout: () => 42, clearTimeout() {} });
  child.stdin.end = () => {};
  const closing = new numericClient('test.exe', () => {}, () => {});
  assert.doesNotThrow(() => closing.close(), 'Shutdown must work with numeric timer IDs');
  console.log('PASS: shutdown with plugin-style numeric timers');

  if (process.argv.includes('--live')) {
    const NativeClient = load(require('node:child_process'));
    let stopping = false;
    const live = new NativeClient('codex', () => {}, error => { if (!stopping) console.error(error.message); });
    try {
      const initialized = await live.request('initialize', { clientInfo: { name: 'joplin_aide_test', version: '1.3.1' } });
      live.send({ method: 'initialized', params: {} });
      assert.ok(initialized);
      // No model invocation or note data: validate the installed server protocol.
      const models = await live.request('model/list', {});
      assert.ok(Array.isArray(models.data));
      console.log('PASS: installed Codex initialize and model/list');
      const proxyExports = {};
      vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/mcpSource.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
      }).outputText, { exports: proxyExports });
      const server = require('node:http').createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ tools: [{ name: 'aide_test_read', description: 'Read a synthetic test note', inputSchema: { type: 'object', properties: {} } }] }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const result = await live.request('thread/start', {
          ephemeral: true, cwd: process.cwd(), sandbox: 'read-only', approvalPolicy: 'on-request',
          developerInstructions: 'Protocol test only. Do not run tools.',
          config: { 'mcp_servers.joplin': {
            command: process.execPath, args: ['-e', proxyExports.MCP_PROXY_SOURCE],
            env: { JOPLIN_AIDE_PORT: String(server.address().port) }, required: true, tool_timeout_sec: 180,
          } },
        });
        assert.ok(result.thread.id);
        const status = await live.request('mcpServerStatus/list', { threadId: result.thread.id });
        const joplin = status.data.find(item => item.name === 'joplin');
        assert.ok(joplin, 'Joplin MCP server registered');
        assert.ok(JSON.stringify(joplin.tools).includes('aide_test_read'), 'Synthetic note tool discovered');
        console.log('PASS: thread configuration and Aide MCP tool discovery');
      } finally { server.close(); }
    } finally {
      stopping = true;
      live.process.stdin.end();
      live.process.kill();
    }
  }
}
test().catch(error => { console.error(error); process.exitCode = 1; });
