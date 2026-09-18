// Codex app-server transport (JSON-RPC over stdio). One process per turn;
// the thread id survives it and the next turn resumes the thread from disk.
import { spawn, spawnSync } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

// Split a user-typed argument string into argv without a shell: whitespace
// separates, double or single quotes group ("-c model=\"o3\"" stays one arg).
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  return out;
}

export class CodexClient {
  readonly process: ReturnType<typeof spawn>;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: any }>();
  private closed = false;
  private closing = false;

  constructor(bin: string, private event: (message: any) => void, private failed: (error: Error) => void, extraArgs: string[] = []) {
    let args = ['app-server', ...extraArgs];
    const env = { ...process.env };
    if (process.platform === 'win32') {
      if (bin === 'codex') {
        const found = spawnSync('where.exe', ['codex'], { windowsHide: true, encoding: 'utf8' });
        bin = (found.stdout || '').split(/\r?\n/).find(path => /\.(exe|cmd)$/i.test(path)) || bin;
      }
      if (/\.cmd$/i.test(bin)) {
        // npm's launcher is a cmd.exe script; run the JS entry point directly
        // under Electron-as-node so nothing passes through cmd.exe.
        const script = join(dirname(bin), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (!existsSync(script)) throw new Error('Select codex.exe or the npm-installed codex.cmd in Aide settings.');
        bin = process.execPath;
        args = [script, 'app-server', ...extraArgs];
        env.ELECTRON_RUN_AS_NODE = '1';
      }
    }
    this.process = spawn(bin, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let stderr = '';
    this.process.stderr!.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    this.process.stdout!.on('data', chunk => {
      buffer += decoder.write(chunk);
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message: any;
        try { message = JSON.parse(line); } catch (_) { continue; }
        const waiting = this.pending.get(message.id);
        if (!message.method && waiting) {
          this.pending.delete(message.id); clearTimeout(waiting.timer);
          if (message.error) waiting.reject(new Error(message.error.message));
          else waiting.resolve(message.result);
        } else this.event(message);
      }
    });
    this.process.on('error', error => this.finish(error));
    this.process.on('close', code => this.finish(new Error('Codex exited (' + code + '). ' + stderr)));
    this.process.stdin!.on('error', error => this.finish(error));
  }

  private finish(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.failed(error);
  }

  send(message: any): void {
    if (!this.closed) this.process.stdin!.write(JSON.stringify(message) + '\n');
  }

  // Graceful shutdown after a finished turn: stdin EOF makes app-server flush
  // the thread to disk and exit (~50 ms measured). Killed if it lingers.
  close(): void {
    if (this.closed || this.closing) return;
    this.closing = true;
    try { this.process.stdin!.end(); } catch (_) { /* already gone */ }
    const timer = setTimeout(() => this.kill(), 2000);
    this.process.once('close', () => clearTimeout(timer));
    // Joplin's sandbox may supply browser-style numeric timer IDs.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  // Immediate stop (Stop button). taskkill /T takes the MCP proxy that
  // app-server spawned down with it; plain kill() would orphan it on Windows.
  kill(): void {
    if (this.closed) return;
    try {
      if (process.platform === 'win32' && this.process.pid) {
        const killer = spawn('taskkill', ['/pid', String(this.process.pid), '/T', '/F'], { windowsHide: true });
        killer.on('error', () => this.process.kill());
      } else this.process.kill();
    } catch (_) { /* nothing left to kill */ }
  }

  request(method: string, params: any): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Codex connection closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error('Codex request timed out: ' + method));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
}
