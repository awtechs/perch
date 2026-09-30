import { type RequestHandler } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Store } from '../store.js';
import { Runner, directory } from '../runner.js';
import { type Configuration } from '../config.js';
import { OAuthProvider, COMMAND_SCOPE } from '../auth/oauth.js';

export function mcp(store:Store,runner:Runner,oauth:OAuthProvider,config:Configuration,version:string):RequestHandler {
  return async (req,res):Promise<void> => {
    const bearer=req.headers.authorization?.match(/^Bearer ([A-Za-z0-9._~-]{32,512})$/)?.[1];
    let client:string;
    try {
      if (!bearer) throw new Error('Authentication required');
      const auth=await oauth.verifyAccessToken(bearer);
      if (!auth.scopes.includes(COMMAND_SCOPE) || auth.resource?.href!==oauth.resource.href) throw new Error('Invalid scope or audience');
      client=auth.clientId;
    } catch {
      res.status(401).set('WWW-Authenticate',`Bearer resource_metadata="${config.PUBLIC_URL}/.well-known/oauth-protected-resource/mcp", scope="${COMMAND_SCOPE}"`).json({error:'Authentication required'});return;
    }
    const server=new McpServer({name:'perch',version});
    const securitySchemes=[{type:'oauth2',scopes:[COMMAND_SCOPE]}];
    const result=(value:object):{content:Array<{type:'text';text:string}>} => ({content:[{type:'text',text:JSON.stringify(value)}]});
    server.registerTool('request_command',{
      title:'Request a VPS command',description:'Queue an arbitrary non-interactive Bash command for owner approval. Saved rules match this authenticated client, exact command and canonical working directory. Provide an idempotency key for safe retries. Never include credentials in command text.',
      inputSchema:{command:z.string().min(1).max(16384).refine(command=>!command.includes('\0')),cwd:z.string().max(4096),timeout_seconds:z.number().int().min(1).max(300).default(60),idempotency_key:z.string().min(1).max(128).optional()},
      annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true},_meta:{securitySchemes},
    },async({command,cwd,timeout_seconds,idempotency_key})=>{
      const job=store.request(client,command,directory(cwd),timeout_seconds,idempotency_key);
      if(job.status==='approved' && runner.available)runner.start(job.id,client);
      return result({...store.get(job.id,client),approval_url:`${config.PUBLIC_URL}/approvals`});
    });
    server.registerTool('execute_approved_command',{
      title:'Execute an approved command',description:'Execute an approved request at most once. This tool cannot change the stored command, directory or timeout. Poll get_command_result for output.',
      inputSchema:{request_id:z.string().uuid()},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true},_meta:{securitySchemes},
    },async({request_id})=>{
      const job=store.get(request_id,client);
      if(job.status==='approved')runner.start(request_id,client);
      return result(store.get(request_id,client));
    });
    server.registerTool('get_command_result',{
      title:'Get command status and output',description:'Read live bounded output and status for a request belonging to your authenticated client.',
      inputSchema:{request_id:z.string().uuid()},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},_meta:{securitySchemes},
    },async({request_id})=>result(store.get(request_id,client)));
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{void transport.close();void server.close();});
    try {await server.connect(transport);await transport.handleRequest(req,res,req.body);}
    catch {if(!res.headersSent)res.status(500).json({error:'MCP request failed'});}
  };
}
