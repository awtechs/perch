import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export type Status = 'pending' | 'approved' | 'denied' | 'expired' | 'running' | 'succeeded' | 'failed' | 'interrupted';
export interface Job { id: string; client_id: string; command: string; cwd: string; timeout: number; status: Status; created: number; output: string; exit_code: number | null; }
const jobSchema=z.object({id:z.string(),client_id:z.string(),command:z.string(),cwd:z.string(),timeout:z.number(),status:z.enum(['pending','approved','denied','expired','running','succeeded','failed','interrupted']),created:z.number(),output:z.string(),exit_code:z.number().nullable()});
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), command TEXT NOT NULL, cwd TEXT NOT NULL, timeout INTEGER NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, output TEXT NOT NULL DEFAULT '', exit_code INTEGER);
      CREATE TABLE IF NOT EXISTS rules(id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), command TEXT NOT NULL, cwd TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(client_id,command,cwd));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL, job_id TEXT);
    `);
    this.db.prepare("UPDATE jobs SET status='interrupted' WHERE status='running'").run();
  }
  registerClient(id: string, name: string, token: string): void {
    this.db.prepare('INSERT INTO clients(id,name,token_hash) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,token_hash=excluded.token_hash').run(id,name,hash(token));
  }
  authenticate(token: string): string | null {
    const row = this.db.prepare('SELECT id FROM clients WHERE token_hash=? AND enabled=1').get(hash(token)) as {id:string} | undefined;
    return row?.id ?? null;
  }
  audit(actor: string, event: string, jobId: string): void {
    this.db.prepare('INSERT INTO audit(at,actor,event,job_id) VALUES(?,?,?,?)').run(Date.now(),actor,event,jobId);
  }
  request(client: string, command: string, cwd: string, timeout: number): Job {
    const allowed = this.db.prepare('SELECT id FROM rules WHERE client_id=? AND command=? AND cwd=?').get(client,command,cwd);
    const id = randomUUID();
    this.db.prepare('INSERT INTO jobs(id,client_id,command,cwd,timeout,status,created) VALUES(?,?,?,?,?,?,?)').run(id,client,command,cwd,timeout,allowed?'approved':'pending',Date.now());
    this.audit(client,allowed?'rule_matched':'approval_requested',id);
    return this.get(id,client);
  }
  get(id: string, client?: string): Job {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Job | undefined;
    if (!row || (client !== undefined && row.client_id !== client)) throw new Error('Job not found');
    if ((row.status === 'pending' || row.status === 'approved') && Date.now()-row.created>600_000) {
      this.db.prepare("UPDATE jobs SET status='expired' WHERE id=? AND status IN ('pending','approved')").run(id);
      row.status='expired';
    }
    return row;
  }
  decide(id: string, decision: 'once'|'always'|'deny'): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job=this.get(id);
      if(job.status!=='pending') throw new Error('This request is no longer pending');
      this.db.prepare('UPDATE jobs SET status=? WHERE id=?').run(decision==='deny'?'denied':'approved',id);
      if(decision==='always') this.db.prepare('INSERT OR IGNORE INTO rules(id,client_id,command,cwd,created) VALUES(?,?,?,?,?)').run(randomUUID(),job.client_id,job.command,job.cwd,Date.now());
      this.audit('owner',`approve_${decision}`,id);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  claim(id: string, client: string): Job {
    const job=this.get(id,client);
    if(job.status!=='approved') throw new Error(`Cannot execute a ${job.status} request`);
    const changed=this.db.prepare("UPDATE jobs SET status='running' WHERE id=? AND client_id=? AND status='approved'").run(id,client);
    if(changed.changes!==1) throw new Error('Request already consumed');
    this.audit(client,'execution_started',id);
    return job;
  }
  finish(id: string, status: 'succeeded'|'failed', output: string, code: number|null): void {
    this.db.prepare('UPDATE jobs SET status=?,output=?,exit_code=? WHERE id=?').run(status,output,code,id);
    this.audit('runner',status,id);
  }
  recent(): Job[] {
    const rows=z.array(jobSchema).parse(this.db.prepare('SELECT * FROM jobs ORDER BY created DESC LIMIT 100').all());
    return rows.map(row=>this.get(row.id));
  }
  rules(): Array<{id:string;client_id:string;command:string;cwd:string}> {
    return this.db.prepare('SELECT id,client_id,command,cwd FROM rules ORDER BY created DESC').all() as Array<{id:string;client_id:string;command:string;cwd:string}>;
  }
  revoke(id: string): void { this.db.prepare('DELETE FROM rules WHERE id=?').run(id); this.audit('owner','rule_revoked',id); }
}
