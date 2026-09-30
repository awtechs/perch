import express, { type ErrorRequestHandler } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mcpAuthRouter, createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { Store } from '../store.js';
import { Runner } from '../runner.js';
import { OAuthProvider, COMMAND_SCOPE } from '../auth/oauth.js';
import { Owner } from '../auth/owner.js';
import { type Configuration } from '../config.js';
import { page, escape } from './views.js';
import { mcp } from './mcp.js';

export function application(store:Store,runner:Runner,oauth:OAuthProvider,config:Configuration,version:string,commit:string):express.Express {
  const app=express();app.disable('x-powered-by');
  if(config.TRUST_PROXY)app.set('trust proxy',config.TRUST_PROXY.split(',').map(address=>address.trim()));
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
    if(config.PUBLIC_URL.startsWith('https:'))res.set('Strict-Transport-Security','max-age=31536000');
    // Only known origins and hosts reach owner actions, OAuth or MCP; proxy trust is explicit.
    const origin=new URL(config.PUBLIC_URL);
    const localHealth=req.path==='/health' && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'');
    if(req.get('host')!==origin.host && !localHealth){res.status(421).send('Unexpected host');return;}
    if(req.headers.origin && req.headers.origin!==origin.origin && !['/register','/token','/revoke'].includes(req.path)){res.status(403).send('Unexpected origin');return;}
    next();
  });
  app.use(express.json({limit:'32kb'}));app.use(express.urlencoded({extended:false,limit:'16kb'}));
  const owner=new Owner(config.ADMIN_PASSWORD,config.PUBLIC_URL.startsWith('https:'));
  app.get('/',(_req,res)=>res.redirect(303,'/approvals'));
  app.get('/health',(_req,res)=>res.json({status:'ok',version,commit}));
  app.get('/login',owner.loginPage);app.post('/login',owner.login);
  app.post('/logout',owner.require,owner.logout);
  app.get('/approvals',owner.require,(req,res)=>{
    const session=owner.get(req);if(!session)throw new Error('Owner session missing');
    const clients=new Map(store.clients().map(client=>[client.id,client.name]));
    const jobs=store.recent().map(job=>{
      const history=store.history(job.id).map(event=>`${new Date(event.at).toISOString()} · ${escape(event.actor)} · ${escape(event.event)}`).join('<br>');
      return `<article><small>${escape(clients.get(job.client_id)??job.client_id)} · ${escape(job.status)} · ${new Date(job.created).toISOString()}</small><p class="muted">Client ID: <code>${escape(job.client_id)}</code></p><pre>${escape(job.command)}</pre><p>Directory: <code>${escape(job.cwd)}</code> · Timeout: ${job.timeout}s</p>${job.status==='pending'?`<form method="post" action="/approvals/${job.id}"><input type="hidden" name="csrf" value="${session.csrf}"><button name="decision" value="once">Approve now</button><button name="decision" value="always">Always approve this command for this client</button><button name="decision" value="deny">Deny</button></form>`:''}${job.output?`<pre>${escape(job.output)}</pre>`:''}<details><summary>Audit history</summary><small>${history}</small></details></article>`;
    }).join('');
    const rules=store.rules().map(rule=>`<article><small>${escape(clients.get(rule.client_id)??rule.client_id)} · ${escape(rule.client_id)}</small><pre>${escape(rule.command)}</pre><p>${escape(rule.cwd)} · Maximum timeout ${rule.max_timeout}s</p><form method="post" action="/rules/${rule.id}/revoke"><input type="hidden" name="csrf" value="${session.csrf}"><button>Revoke approval</button></form></article>`).join('');
    res.send(page(`<h1>Command approvals</h1><p>Requests expire after ten minutes. Refresh for live command output.</p>${jobs||'<p>No requests.</p>'}<h1>Saved approvals</h1><p>A saved approval applies to the exact command and directory for this client, up to the displayed timeout. Files and scripts called by that command can change.</p>${rules||'<p>No saved approvals.</p>'}<form method="post" action="/logout"><input type="hidden" name="csrf" value="${session.csrf}"><button>Sign out</button></form>`));
  });
  app.post('/approvals/:id',owner.require,(req,res)=>{
    const {decision}=z.object({decision:z.enum(['once','always','deny'])}).parse(req.body);
    store.decide(z.string().uuid().parse(req.params.id),decision);res.redirect(303,'/approvals');
  });
  app.post('/rules/:id/revoke',owner.require,(req,res)=>{store.revoke(z.string().uuid().parse(req.params.id));res.redirect(303,'/approvals');});
  app.get('/clients',owner.require,(req,res)=>{
    const session=owner.get(req);if(!session)throw new Error('Owner session missing');
    const clients=store.clients().map(client=>`<article><strong>${escape(client.name)}</strong><p><code>${escape(client.id)}</code> · ${client.enabled?'Enabled':'Disabled / awaiting consent'}</p>${client.enabled?`<form method="post" action="/clients/${client.id}/disable"><input type="hidden" name="csrf" value="${session.csrf}"><button>Disable client and revoke its tokens</button></form>`:''}</article>`).join('');
    res.send(page(`<h1>Connected clients</h1><p>OAuth clients require owner consent. Each client keeps its own command approvals.</p>${clients}<h2>Create a token client</h2><form method="post" action="/clients"><input type="hidden" name="csrf" value="${session.csrf}"><label>Client name <input name="name" required maxlength="256"></label><button>Create client</button></form>`));
  });
  app.post('/clients',owner.require,(req,res)=>{
    const {name}=z.object({name:z.string().trim().min(1).max(256)}).parse(req.body);
    const id=randomUUID();const token=randomBytes(48).toString('base64url');store.registerClient(id,name,token);store.audit('owner','token_client_created',id);
    res.send(page(`<h1>Client created</h1><p>${escape(name)} · <code>${id}</code></p><p>Copy this token now. It cannot be displayed again.</p><pre>${token}</pre><p>Use it as the Bearer token for <code>${escape(config.PUBLIC_URL)}/mcp</code>.</p>`));
  });
  app.post('/clients/:id/disable',owner.require,(req,res)=>{const clientId=z.string().min(1).max(256).parse(req.params.id);oauth.revokeClient(clientId);runner.cancelClient(clientId);res.redirect(303,'/clients');});
  app.get('/oauth/consent',owner.require,(req,res)=>{
    const {request}=z.object({request:z.string().regex(/^[a-f0-9]{64}$/)}).parse(req.query);
    const consent=oauth.consent(request);const session=owner.get(req);if(!session)throw new Error('Owner session missing');
    res.send(page(`<h1>Connect an MCP client</h1><p>App-provided name: <strong>${escape(consent.client.client_name??'Unnamed client')}</strong></p><p>Client ID: <code>${escape(consent.client.client_id)}</code></p><p>Callback: <code>${escape(consent.params.redirectUri)}</code></p><p>This client may request VPS commands and read its own output. Every command still requires approval unless you save a matching rule for this client.</p><form method="post" action="/oauth/consent"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="request" value="${request}"><button name="decision" value="allow">Connect this client</button><button name="decision" value="deny">Deny</button></form>`));
  });
  app.post('/oauth/consent',owner.require,(req,res)=>{
    const body=z.object({request:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(['allow','deny'])}).parse(req.body);
    res.redirect(303,oauth.decide(body.request,body.decision==='allow').href);
  });
  const authOptions={provider:oauth,issuerUrl:oauth.issuer,resourceServerUrl:oauth.resource,scopesSupported:[COMMAND_SCOPE],resourceName:'Perch VPS management'};
  app.get('/.well-known/oauth-authorization-server',(_req,res)=>res.json({...createOAuthMetadata(authOptions),authorization_response_iss_parameter_supported:true}));
  app.use(mcpAuthRouter(authOptions));
  app.post('/mcp',mcp(store,runner,oauth,config,version));
  app.all('/mcp',(_req,res)=>{res.status(405).set('Allow','POST').end();});
  app.use((_req,res)=>res.status(404).send('Not found'));
  const errors:ErrorRequestHandler=(error:Error,_req,res,_next):void=>{
    if(res.headersSent)return;
    const badRequest=error instanceof z.ZodError || error instanceof SyntaxError;
    console.error(JSON.stringify({event:'request_failed',type:error.name}));
    res.status(badRequest?400:409).send(badRequest?'Invalid request':'The action could not be completed. Refresh and check the request status.');
  };
  app.use(errors);return app;
}
