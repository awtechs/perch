import express, { type Request, type Response } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { Store, hash } from './store.js';
import { directory, execute } from './runner.js';

const env=z.object({ADMIN_PASSWORD:z.string().min(24),CLIENT_TOKEN:z.string().min(32),CLIENT_ID:z.string().default('bootstrap'),CLIENT_NAME:z.string().default('Bootstrap test client'),DATA_DIR:z.string().default('./data'),HOST:z.string().default('127.0.0.1'),PORT:z.coerce.number().default(8787),PUBLIC_URL:z.string().url().default('http://127.0.0.1:8787')}).parse(process.env);
const version=z.object({version:z.string()}).parse(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'))).version;
mkdirSync(env.DATA_DIR,{recursive:true,mode:0o700});
const store=new Store(`${env.DATA_DIR}/state.sqlite`);
store.registerClient(env.CLIENT_ID,env.CLIENT_NAME,env.CLIENT_TOKEN);
const app=express();
app.disable('x-powered-by');
app.use((req,res,next)=>{
  res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"});next();
});
app.use(express.json({limit:'32kb'}));app.use(express.urlencoded({extended:false,limit:'8kb'}));
const sessions=new Map<string,{csrf:string;expires:number}>();
const failures=new Map<string,{count:number;expires:number}>();
const escape=(value:string):string=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]??char));
const page=(body:string):string=>`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Perch approval</title><style>body{max-width:900px;margin:40px auto;padding:0 20px;font:16px system-ui;background:#111315;color:#e6e9eb}article{border:1px solid #34383c;border-radius:12px;padding:20px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#080a0b;padding:16px}button,input{font:inherit;padding:10px;margin:6px 6px 6px 0}button{cursor:pointer}small{color:#a7b1b8}h1{font-size:26px}</style><body>${body}</body></html>`;
function session(req:Request):{csrf:string;expires:number}|undefined {
  const cookie=req.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith('vps_owner='))?.slice(10);
  if(!cookie)return;const found=sessions.get(cookie);if(found&&found.expires>Date.now())return found;sessions.delete(cookie);
}
function owner(req:Request,res:Response,next:()=>void):void {
  const found=session(req);if(!found){res.redirect(303,'/login');return;}
  if(req.method==='POST'){
    const token=z.object({csrf:z.string()}).safeParse(req.body);
    if(!token.success||token.data.csrf!==found.csrf){res.status(403).send('Invalid approval session');return;}
  }next();
}
app.get('/health',(_req,res)=>res.json({status:'ok',version}));
app.get('/login',(_req,res)=>res.send(page('<h1>VPS approvals</h1><form method="post" action="/login"><label>Owner password <input name="password" type="password" required autocomplete="current-password"></label><button>Sign in</button></form>')));
app.post('/login',(req,res)=>{
  const key=req.socket.remoteAddress??'local';const entry=failures.get(key);
  if(entry&&entry.expires>Date.now()&&entry.count>=5){res.status(429).send('Try again in 15 minutes');return;}
  const parsed=z.object({password:z.string()}).safeParse(req.body);
  const correct=parsed.success&&timingSafeEqual(Buffer.from(hash(parsed.data.password)),Buffer.from(hash(env.ADMIN_PASSWORD)));
  if(!correct){const old=entry&&entry.expires>Date.now()?entry.count:0;failures.set(key,{count:old+1,expires:Date.now()+900_000});res.status(401).send('Invalid password');return;}
  failures.delete(key);const id=randomBytes(32).toString('hex');
  for(const [key,value] of sessions)if(value.expires<Date.now())sessions.delete(key);
  sessions.set(id,{csrf:randomBytes(32).toString('hex'),expires:Date.now()+3_600_000});
  res.setHeader('Set-Cookie',`vps_owner=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${env.PUBLIC_URL.startsWith('https:')?'; Secure':''}`);res.redirect(303,'/approvals');
});
app.get('/approvals',owner,(req,res)=>{
  const csrf=session(req)!.csrf;
  const jobs=store.recent().map(job=>`<article><small>${escape(job.client_id)} · ${escape(job.status)} · ${new Date(job.created).toISOString()}</small><pre>${escape(job.command)}</pre><p>Working directory: ${escape(job.cwd)} · timeout: ${job.timeout}s</p>${job.status==='pending'?`<form method="post" action="/approvals/${job.id}"><input type="hidden" name="csrf" value="${csrf}"><button name="decision" value="once">Approve now</button><button name="decision" value="always">Always approve this command for this client</button><button name="decision" value="deny">Deny</button></form>`:''}${job.output?`<pre>${escape(job.output)}</pre>`:''}</article>`).join('');
  const rules=store.rules().map(rule=>`<article><small>${escape(rule.client_id)}</small><pre>${escape(rule.command)}</pre><p>${escape(rule.cwd)}</p><form method="post" action="/rules/${rule.id}/revoke"><input type="hidden" name="csrf" value="${csrf}"><button>Revoke approval</button></form></article>`).join('');
  res.send(page(`<h1>Command approvals</h1><p>Requests expire after ten minutes. Refresh to see new requests.</p>${jobs||'<p>No requests.</p>'}<h1>Saved approvals</h1>${rules||'<p>No saved approvals.</p>'}`));
});
app.post('/approvals/:id',owner,(req,res)=>{
  const parsed=z.object({decision:z.enum(['once','always','deny'])}).parse(req.body);
  store.decide(String(req.params.id),parsed.decision);res.redirect(303,'/approvals');
});
app.post('/rules/:id/revoke',owner,(req,res)=>{store.revoke(String(req.params.id));res.redirect(303,'/approvals');});
const ongoing=new Set<string>();
function start(id:string,client:string):void {
  if(ongoing.size>=4)throw new Error('Four commands are already running; retry later');
  ongoing.add(id);void execute(store,id,client).catch((error:Error)=>{console.error(`Execution ${id}: ${error.message}`);}).finally(()=>ongoing.delete(id));
}
app.post('/mcp',async(req,res)=>{
  const bearer=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  const client=bearer?store.authenticate(bearer):null;
  if(!client){res.status(401).json({error:'Authentication required'});return;}
  const origin=req.headers.origin;if(origin&&origin!==new URL(env.PUBLIC_URL).origin){res.status(403).end();return;}
  const server=new McpServer({name:'perch',version});
  const result=(value:object):{content:Array<{type:'text';text:string}>}=>({content:[{type:'text',text:JSON.stringify(value)}]});
  server.registerTool('request_command',{description:'Request an arbitrary Bash command. Unapproved commands are queued for owner approval; exact saved approvals are scoped to the authenticated client and canonical working directory. Never send passwords in commands.',inputSchema:{command:z.string().min(1).max(16384),cwd:z.string(),timeout_seconds:z.number().int().min(1).max(300).default(60)}},async({command,cwd,timeout_seconds})=>{
    if(store.recent().filter(job=>job.client_id===client&&job.status==='pending').length>=20)throw new Error('Too many pending approvals');
    const job=store.request(client,command,directory(cwd),timeout_seconds);
    if(job.status==='approved')start(job.id,client);
    return result({...store.get(job.id,client),approval_url:`${env.PUBLIC_URL}/approvals`});
  });
  server.registerTool('execute_approved_command',{description:'Execute an approved request once. Its command and directory cannot be changed. Returns promptly; poll get_command_result.',inputSchema:{request_id:z.string().uuid()}},async({request_id})=>{
    const job=store.get(request_id,client);
    if(job.status==='approved')start(request_id,client);
    return result(store.get(request_id,client));
  });
  server.registerTool('get_command_result',{description:'Get status and bounded output for your own request.',inputSchema:{request_id:z.string().uuid()},annotations:{readOnlyHint:true}},async({request_id})=>result(store.get(request_id,client)));
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.on('close',()=>{void transport.close();void server.close();});
  try {await server.connect(transport);await transport.handleRequest(req,res,req.body);}catch(error){console.error(error instanceof Error?error.message:'MCP error');if(!res.headersSent)res.status(500).json({error:'MCP request failed'});}
});
app.all('/mcp',(_req,res)=>{res.status(405).setHeader('Allow','POST');res.end();});
app.use((error:Error,_req:Request,res:Response,_next:(error?:Error)=>void)=>{res.status(400).send(escape(error.message));});
app.listen(env.PORT,env.HOST,()=>console.log(`Perch listening on ${env.HOST}:${env.PORT}`));
