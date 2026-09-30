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

test('safe retries return the original request and reject mismatched contents',async()=>{
  const store=setup();const first=store.request('a','printf once','/tmp',60,'retry-1');
  const retry=store.request('a','printf once','/tmp',60,'retry-1');assert.equal(first.id,retry.id);
  assert.throws(()=>store.request('a','printf changed','/tmp',60,'retry-1'),/another command/);
  store.decide(first.id,'once');await execute(store,first.id,'a');
  assert.equal(store.request('a','printf once','/tmp',60,'retry-1').status,'succeeded');
});
test('revocation invalidates unstarted rule approvals and timeout changes need consent',()=>{
  const store=setup();const first=store.request('a','true','/tmp',1);store.decide(first.id,'always');
  const next=store.request('a','true','/tmp',1);assert.equal(next.status,'approved');
  assert.equal(store.request('a','true','/tmp',2).status,'pending');
  store.revoke(store.rules()[0].id);assert.equal(store.get(next.id).status,'denied');assert.throws(()=>store.claim(next.id,'a'),/denied/);
});
test('disabling a client prevents new commands and consumes unused approvals',()=>{
  const store=setup();const job=store.request('a','true','/tmp',60);store.decide(job.id,'once');store.setClientEnabled('a',false);
  assert.equal(store.authenticate('a-token'),null);assert.equal(store.get(job.id).status,'denied');
  assert.throws(()=>store.request('a','true','/tmp',60),/disabled/);assert.throws(()=>store.claim(job.id,'a'),/disabled/);
});
test('queue limits count all pending rows, even when they are absent from recent results',()=>{
  const store=setup();for(let i=0;i<20;i++)store.request('a',`printf ${i}`,'/tmp',60);
  for(let c=0;c<5;c++){const id=`extra-${c}`;store.registerClient(id,id,id);for(let i=0;i<20;i++)store.request(id,'true','/tmp',60);}
  assert.equal(store.recent().length,100);assert.throws(()=>store.request('a','true','/tmp',60),/outstanding/);
});
test('output is available while execution is running and shutdown interrupts the process',async()=>{
  const {Runner}=await import('../src/runner.js');const store=setup();const runner=new Runner(store,1);
  const job=store.request('a','printf streaming; sleep 10','/tmp',60);store.decide(job.id,'once');runner.start(job.id,'a');
  await new Promise(resolve=>setTimeout(resolve,350));assert.equal(store.get(job.id).status,'running');assert.match(store.get(job.id).output,/streaming/);
  await runner.shutdown();assert.equal(store.get(job.id).status,'interrupted');assert.ok(store.get(job.id).ended_at);
});
