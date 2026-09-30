import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { Store } from './store.js';

export function directory(path: string): string {
  if (!path.startsWith('/') || path.includes('\0')) throw new Error('Working directory must be an absolute path');
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error('Working directory is not a directory');
  return canonical;
}

export class Runner {
  private readonly active = new Map<string, (reason:string) => void>();
  private stopping = false;
  constructor(private readonly store: Store, private readonly concurrency = 4) {}
  get available():boolean { return !this.stopping && this.active.size<this.concurrency; }
  cancelClient(client:string):void {
    for(const [id,cancel] of this.active)if(this.store.get(id).client_id===client)cancel('Client disabled by owner');
  }
  start(id: string, client: string): void {
    if (this.active.has(id)) return;
    if (this.stopping || this.active.size >= this.concurrency) throw new Error('Runner is busy; retry this request later');
    const job = this.store.get(id, client);
    try {
      if (directory(job.cwd) !== job.cwd) throw new Error('Working directory changed since approval');
    } catch (error) {
      if (job.status === 'approved') this.store.failBeforeSpawn(id, error instanceof Error ? error.message : 'Working directory is unavailable');
      throw error;
    }
    this.store.claim(id, client);
    let output = Buffer.alloc(0); let truncated = false; let timedOut = false; let interrupted = ''; let finished = false;
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', job.command], {
      cwd: job.cwd, detached: true,
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: homedir(), LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const kill = (): void => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } } };
    this.active.set(id, (reason:string) => { interrupted = reason; kill(); });
    const text = (): string => output.toString('utf8') + (truncated ? '\n[Output truncated]' : '');
    const capture = (data: Buffer): void => {
      const remaining = 256 * 1024 - output.length;
      if (remaining > 0) output = Buffer.concat([output, data.subarray(0, remaining)]);
      if (data.length > remaining) truncated = true;
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const progress = setInterval(() => this.store.progress(id, text(), child.pid ?? null, truncated), 250);
    const timeout = setTimeout(() => { timedOut = true; kill(); }, job.timeout * 1000);
    const finish = (code: number | null, error?: string): void => {
      if (finished) return; finished = true;
      clearInterval(progress); clearTimeout(timeout); kill();
      const result = text() + (timedOut ? '\n[Timed out]' : '') + (interrupted ? `\n[Interrupted: ${interrupted}]` : '') + (error ? `\n${error}` : '');
      this.store.progress(id, result, null, truncated);
      this.store.finish(id, interrupted ? 'interrupted' : code === 0 && !timedOut && !error ? 'succeeded' : 'failed', result, code);
      this.active.delete(id);
    };
    child.on('error', (error: Error) => finish(null, error.message));
    // Close follows all output streams; timeout also kills descendants holding those streams open.
    child.on('close', (code: number | null) => finish(code));
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const cancel of this.active.values()) cancel('Server shutdown');
    const deadline = Date.now() + 5000;
    while (this.active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// Synchronous ownership checks followed by asynchronous completion, useful to embedders and tests.
export async function execute(store: Store, id: string, client: string): Promise<void> {
  const runner = new Runner(store, 1); runner.start(id, client);
  while (store.get(id, client).status === 'running') await new Promise(resolve => setTimeout(resolve, 10));
}
