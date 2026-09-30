import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { execute } from '../src/runner.js';

function setup():Store {const store=new Store(':memory:');store.registerClient('a','Client A','a-token');store.registerClient('b','Client B','b-token');return store;}
test('pending commands cannot execute; another client cannot read or consume approval',async()=>{
  const store=setup();const job=store.request('a','printf test','/tmp',60);
  await assert.rejects(execute(store,job.id,'a'),/pending/);assert.throws(()=>store.get(job.id,'b'),/not found/);
  store.decide(job.id,'once');await assert.rejects(execute(store,job.id,'b'),/not found/);
  await execute(store,job.id,'a');assert.equal(store.get(job.id).output,'test');
  await assert.rejects(execute(store,job.id,'a'),/succeeded/);assert.equal(store.request('a','printf test','/tmp',60).status,'pending');
});
test('always approvals match client, exact command and directory; revocation works',()=>{
  const store=setup();const job=store.request('a','printf test','/tmp',60);store.decide(job.id,'always');
  assert.equal(store.request('a','printf test','/tmp',60).status,'approved');
  for(const [client,command,cwd] of [['b','printf test','/tmp'],['a','printf test; id','/tmp'],['a','printf test','/']])assert.equal(store.request(client,command,cwd,60).status,'pending');
  store.revoke(store.rules()[0].id);assert.equal(store.request('a','printf test','/tmp',60).status,'pending');
});
test('denial and expiry block execution and double decisions',()=>{
  const store=setup();const denied=store.request('a','true','/tmp',60);store.decide(denied.id,'deny');assert.throws(()=>store.claim(denied.id,'a'),/denied/);assert.throws(()=>store.decide(denied.id,'always'),/no longer/);
  const expired=store.request('a','true','/tmp',60);store.db.prepare('UPDATE jobs SET created=? WHERE id=?').run(Date.now()-700_000,expired.id);assert.equal(store.get(expired.id).status,'expired');assert.throws(()=>store.decide(expired.id,'once'),/no longer/);
});
test('timeouts terminate execution and record failure',async()=>{
  const store=setup();const job=store.request('a','sleep 10','/tmp',1);store.decide(job.id,'once');await execute(store,job.id,'a');assert.equal(store.get(job.id).status,'failed');assert.match(store.get(job.id).output,/Timed out/);
});
