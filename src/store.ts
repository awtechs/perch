import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const statusSchema = z.enum(['pending', 'approved', 'denied', 'expired', 'running', 'succeeded', 'failed', 'interrupted']);
const jobSchema = z.object({
  id: z.string(), client_id: z.string(), command: z.string(), cwd: z.string(), timeout: z.number(),
  status: statusSchema, created: z.number(), output: z.string(), exit_code: z.number().nullable(),
  approval_kind: z.enum(['once', 'rule']).nullable(), approval_rule_id: z.string().nullable(),
  idempotency_key: z.string().nullable(), approved_at: z.number().nullable(), started_at: z.number().nullable(),
  ended_at: z.number().nullable(), pid: z.number().nullable(), output_truncated: z.number(),
});
export type Job = z.infer<typeof jobSchema>;
export type Status = Job['status'];
const clientSchema = z.object({ id: z.string(), name: z.string(), enabled: z.number() });
const ruleSchema = z.object({ id: z.string(), client_id: z.string(), command: z.string(), cwd: z.string(), max_timeout: z.number() });

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), command TEXT NOT NULL, cwd TEXT NOT NULL, timeout INTEGER NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, output TEXT NOT NULL DEFAULT '', exit_code INTEGER);
      CREATE TABLE IF NOT EXISTS rules(id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), command TEXT NOT NULL, cwd TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(client_id,command,cwd));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL, job_id TEXT);
    `);
    this.transaction(() => {
      const columns = new Set(z.array(z.object({ name: z.string() })).parse(this.db.prepare('PRAGMA table_info(jobs)').all()).map(column => column.name));
      for (const [name, definition] of Object.entries({ approval_kind: 'TEXT', approval_rule_id: 'TEXT', idempotency_key: 'TEXT', approved_at: 'INTEGER', started_at: 'INTEGER', ended_at: 'INTEGER', pid: 'INTEGER', output_truncated: 'INTEGER NOT NULL DEFAULT 0' })) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
      }
      const ruleColumns = z.array(z.object({ name: z.string() })).parse(this.db.prepare('PRAGMA table_info(rules)').all());
      if (!ruleColumns.some(column => column.name === 'max_timeout')) this.db.exec('ALTER TABLE rules ADD COLUMN max_timeout INTEGER NOT NULL DEFAULT 300');
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency ON jobs(client_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS jobs_client_status ON jobs(client_id,status);
        CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created);
        CREATE INDEX IF NOT EXISTS audit_job ON audit(job_id,id);
        PRAGMA user_version=1;`);
    });
  }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recover(): void {
    this.transaction(() => {
      const running = z.array(z.object({ id: z.string() })).parse(this.db.prepare("SELECT id FROM jobs WHERE status='running'").all());
      this.db.prepare("UPDATE jobs SET status='interrupted',ended_at=?,pid=NULL WHERE status='running'").run(Date.now());
      for (const job of running) this.audit('system', 'execution_interrupted', job.id);
    });
  }
  registerClient(id: string, name: string, token: string, enabled = true): void {
    this.db.prepare('INSERT INTO clients(id,name,token_hash,enabled) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,token_hash=excluded.token_hash').run(id, name, hash(token), enabled ? 1 : 0);
  }
  enabled(id: string): boolean {
    const row = this.db.prepare('SELECT enabled FROM clients WHERE id=?').get(id);
    return row !== undefined && z.object({ enabled: z.number() }).parse(row).enabled === 1;
  }
  authenticate(token: string): string | null {
    const row = this.db.prepare('SELECT id FROM clients WHERE token_hash=? AND enabled=1').get(hash(token));
    return row ? z.object({ id: z.string() }).parse(row).id : null;
  }
  clients(): Array<z.infer<typeof clientSchema>> {
    return z.array(clientSchema).parse(this.db.prepare('SELECT id,name,enabled FROM clients ORDER BY name,id').all());
  }
  setClientEnabled(id: string, enabled: boolean): void {
    this.transaction(() => {
      const result = this.db.prepare('UPDATE clients SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id);
      if (result.changes !== 1) throw new Error('Client not found');
      if (!enabled) this.db.prepare("UPDATE jobs SET status='denied',ended_at=? WHERE client_id=? AND status IN ('pending','approved')").run(Date.now(), id);
      this.audit('owner', enabled ? 'client_enabled' : 'client_disabled', id);
    });
  }
  audit(actor: string, event: string, jobId: string): void {
    this.db.prepare('INSERT INTO audit(at,actor,event,job_id) VALUES(?,?,?,?)').run(Date.now(), actor, event, jobId);
  }
  history(id: string): Array<{at:number;actor:string;event:string}> {
    return z.array(z.object({at:z.number(),actor:z.string(),event:z.string()})).parse(this.db.prepare('SELECT at,actor,event FROM audit WHERE job_id=? ORDER BY id').all(id));
  }
  expire(): void {
    this.db.prepare("UPDATE jobs SET status='expired',ended_at=? WHERE status IN ('pending','approved') AND created<?").run(Date.now(), Date.now() - 600_000);
  }
  request(client: string, command: string, cwd: string, timeout: number, key?: string): Job {
    return this.transaction(() => {
      if (!this.enabled(client)) throw new Error('Client is disabled');
      if (key) {
        const existing = this.db.prepare('SELECT * FROM jobs WHERE client_id=? AND idempotency_key=?').get(client, key);
        if (existing) {
          const job = jobSchema.parse(existing);
          if (job.command !== command || job.cwd !== cwd || job.timeout !== timeout) throw new Error('Idempotency key already belongs to another command');
          return this.get(job.id, client);
        }
      }
      this.expire();
      const outstanding = z.object({ count: z.number() }).parse(this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE client_id=? AND status IN ('pending','approved')").get(client));
      if (outstanding.count >= 20) throw new Error('Too many outstanding approvals');
      const global = z.object({ count: z.number() }).parse(this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending','approved')").get());
      if (global.count >= 200) throw new Error('Approval queue is full');
      const row = this.db.prepare('SELECT id FROM rules WHERE client_id=? AND command=? AND cwd=? AND max_timeout>=?').get(client, command, cwd, timeout);
      const ruleId = row ? z.object({ id: z.string() }).parse(row).id : null;
      const id = randomUUID(); const now = Date.now();
      this.db.prepare('INSERT INTO jobs(id,client_id,command,cwd,timeout,status,created,approval_kind,approval_rule_id,idempotency_key,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, client, command, cwd, timeout, ruleId ? 'approved' : 'pending', now, ruleId ? 'rule' : null, ruleId, key ?? null, ruleId ? now : null);
      this.audit(client, ruleId ? 'rule_matched' : 'approval_requested', id);
      return this.get(id, client);
    });
  }
  get(id: string, client?: string): Job {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row) throw new Error('Job not found');
    const job = jobSchema.parse(row);
    if (client !== undefined && job.client_id !== client) throw new Error('Job not found');
    if ((job.status === 'pending' || job.status === 'approved') && Date.now() - job.created > 600_000) {
      this.db.prepare("UPDATE jobs SET status='expired',ended_at=? WHERE id=? AND status IN ('pending','approved')").run(Date.now(), id);
      job.status = 'expired';
    }
    return job;
  }
  decide(id: string, decision: 'once' | 'always' | 'deny'): void {
    this.transaction(() => {
      const job = this.get(id);
      if (job.status !== 'pending') throw new Error('This request is no longer pending');
      if (!this.enabled(job.client_id)) throw new Error('Client is disabled');
      let ruleId: string | null = null;
      if (decision === 'always') {
        ruleId = randomUUID();
        this.db.prepare('INSERT INTO rules(id,client_id,command,cwd,created,max_timeout) VALUES(?,?,?,?,?,?) ON CONFLICT(client_id,command,cwd) DO UPDATE SET max_timeout=excluded.max_timeout').run(ruleId, job.client_id, job.command, job.cwd, Date.now(), job.timeout);
        ruleId = z.object({ id: z.string() }).parse(this.db.prepare('SELECT id FROM rules WHERE client_id=? AND command=? AND cwd=?').get(job.client_id, job.command, job.cwd)).id;
      }
      this.db.prepare('UPDATE jobs SET status=?,approval_kind=?,approval_rule_id=?,approved_at=? WHERE id=?').run(decision === 'deny' ? 'denied' : 'approved', decision === 'always' ? 'rule' : 'once', ruleId, Date.now(), id);
      this.audit('owner', `approve_${decision}`, id);
    });
  }
  claim(id: string, client: string): Job {
    return this.transaction(() => {
      const job = this.get(id, client);
      if (!this.enabled(client)) throw new Error('Client is disabled');
      if (job.status !== 'approved') throw new Error(`Cannot execute a ${job.status} request`);
      if (job.approval_kind === 'rule' && !this.db.prepare('SELECT id FROM rules WHERE id=? AND client_id=? AND command=? AND cwd=? AND max_timeout>=?').get(job.approval_rule_id, client, job.command, job.cwd, job.timeout)) throw new Error('Saved approval was revoked');
      const changed = this.db.prepare("UPDATE jobs SET status='running',started_at=? WHERE id=? AND client_id=? AND status='approved'").run(Date.now(), id, client);
      if (changed.changes !== 1) throw new Error('Request already consumed');
      this.audit(client, 'execution_started', id); return job;
    });
  }
  progress(id: string, output: string, pid: number | null, truncated: boolean): void {
    this.db.prepare("UPDATE jobs SET output=?,pid=?,output_truncated=? WHERE id=? AND status='running'").run(output, pid, truncated ? 1 : 0, id);
  }
  finish(id: string, status: 'succeeded' | 'failed' | 'interrupted', output: string, code: number | null): void {
    this.transaction(() => {
      this.db.prepare("UPDATE jobs SET status=?,output=?,exit_code=?,ended_at=?,pid=NULL WHERE id=? AND status='running'").run(status, output, code, Date.now(), id);
      this.audit('runner', status, id);
    });
  }
  failBeforeSpawn(id: string, reason: string): void {
    this.db.prepare("UPDATE jobs SET status='failed',output=?,ended_at=? WHERE id=? AND status='approved'").run(reason, Date.now(), id);
    this.audit('runner', 'preflight_failed', id);
  }
  recent(): Job[] {
    this.expire(); return z.array(jobSchema).parse(this.db.prepare('SELECT * FROM jobs ORDER BY created DESC LIMIT 100').all());
  }
  rules(): Array<z.infer<typeof ruleSchema>> {
    return z.array(ruleSchema).parse(this.db.prepare('SELECT id,client_id,command,cwd,max_timeout FROM rules ORDER BY created DESC').all());
  }
  revoke(id: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM rules WHERE id=?').run(id);
      this.db.prepare("UPDATE jobs SET status='denied',ended_at=? WHERE approval_rule_id=? AND status='approved'").run(Date.now(), id);
      this.audit('owner', 'rule_revoked', id);
    });
  }
}
