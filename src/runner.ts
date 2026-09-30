import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { Store } from './store.js';

export function directory(path: string): string {
  if(!path.startsWith('/')) throw new Error('Working directory must be absolute');
  const canonical=realpathSync(path);
  if(!statSync(canonical).isDirectory()) throw new Error('Working directory is not a directory');
  return canonical;
}

export async function execute(store: Store, id: string, client: string): Promise<void> {
  const job=store.get(id,client);
  if(directory(job.cwd)!==job.cwd) throw new Error('Working directory changed since approval');
  store.claim(id,client);
  await new Promise<void>((resolve)=>{
    let output=''; let bytes=0; let timedOut=false; let finished=false;
    const child=spawn('/bin/bash',['--noprofile','--norc','-c',job.command],{
      cwd:job.cwd,detached:true,env:{PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/root',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe']
    });
    const capture=(data:Buffer):void=> { const remaining=256*1024-bytes; if(remaining>0){const chunk=data.subarray(0,remaining);output+=chunk.toString();bytes+=chunk.length;} };
    child.stdout.on('data',capture);child.stderr.on('data',capture);
    const kill=():void=>{if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{ /* process already exited */ }}};
    const timer=setTimeout(()=>{timedOut=true;kill();},job.timeout*1000);
    const finish=(code:number|null,error?:string):void=>{
      if(finished)return;finished=true;clearTimeout(timer);kill();
      store.finish(id,code===0&&!timedOut&&!error?'succeeded':'failed',output+(bytes>=256*1024?'\n[Output truncated]':'')+(timedOut?'\n[Timed out]':'')+(error?`\n${error}`:''),code);resolve();
    };
    child.on('error',(error:Error)=>finish(null,error.message));
    child.on('close',(code:number|null)=>finish(code));
  });
}
