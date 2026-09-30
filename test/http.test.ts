import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

test('MCP transport, owner login, CSRF, one-time approval and saved approval',async()=>{
  const data=mkdtempSync(`${tmpdir()}/vps-mcp-test-`);const token=randomBytes(32).toString('hex');const password=randomBytes(32).toString('hex');const url='http://127.0.0.1:18787';
  const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,DATA_DIR:data,PORT:'18787',PUBLIC_URL:url,CLIENT_TOKEN:token,ADMIN_PASSWORD:password},stdio:['ignore','pipe','pipe']});
  const client=new Client({name:'integration-test',version:'1'});
  try{
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server did not start')),10000);child.stdout.on('data',()=>{clearTimeout(timer);resolve();});child.on('error',reject);child.on('exit',code=>reject(new Error(`Server exited ${code}`)));});
    assert.equal((await fetch(`${url}/mcp`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
    const responseSchema=z.object({content:z.array(z.object({type:z.literal('text'),text:z.string()}))});
    const jobSchema=z.object({id:z.string(),status:z.string(),output:z.string()});
    const parse=(result:object):z.infer<typeof jobSchema>=>jobSchema.parse(JSON.parse(responseSchema.parse(result).content[0].text));
    const command='printf integration-ok';const requested=parse(await client.callTool({name:'request_command',arguments:{command,cwd:'/tmp'}}));
    assert.equal(requested.status,'pending');
    assert.equal(parse(await client.callTool({name:'execute_approved_command',arguments:{request_id:requested.id}})).status,'pending');
    const login=await fetch(`${url}/login`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password}),redirect:'manual'});
    assert.equal(login.status,303);const cookie=login.headers.get('set-cookie')!.split(';')[0];
    const html=await(await fetch(`${url}/approvals`,{headers:{Cookie:cookie}})).text();const csrf=html.match(/name="csrf" value="([a-f0-9]+)"/)![1];
    const approve=async(id:string,decision:string,csrfValue=csrf):Promise<Response>=>fetch(`${url}/approvals/${id}`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:csrfValue,decision}),redirect:'manual'});
    assert.equal((await approve(requested.id,'once','bad')).status,403);
    assert.equal((await approve(requested.id,'once')).status,303);
    await client.callTool({name:'execute_approved_command',arguments:{request_id:requested.id}});
    let completed=requested;
    for(let n=0;n<50;n++){completed=parse(await client.callTool({name:'get_command_result',arguments:{request_id:requested.id}}));if(completed.status==='succeeded')break;await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(completed.status,'succeeded');assert.equal(completed.output,'integration-ok');
    const second=parse(await client.callTool({name:'request_command',arguments:{command,cwd:'/tmp'}}));assert.equal(second.status,'pending');assert.equal((await approve(second.id,'always')).status,303);
    const third=parse(await client.callTool({name:'request_command',arguments:{command,cwd:'/tmp'}}));assert.ok(['running','succeeded'].includes(third.status));
  } finally {await client.close();child.kill();await new Promise<void>(resolve=>child.once('exit',()=>resolve()));rmSync(data,{recursive:true,force:true});}
});
