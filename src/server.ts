import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { z } from 'zod';
import { configuration } from './config.js';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { Vault } from './auth/vault.js';
import { OAuthProvider } from './auth/oauth.js';
import { application } from './http/app.js';

const config=configuration(process.env);
const version=z.object({version:z.string()}).parse(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'))).version;
const commitFile=new URL('../COMMIT',import.meta.url);
const commit=existsSync(commitFile)?readFileSync(commitFile,'utf8').trim():'development';
mkdirSync(config.DATA_DIR,{recursive:true,mode:0o700});
const store=new Store(`${config.DATA_DIR}/state.sqlite`);
chmodSync(`${config.DATA_DIR}/state.sqlite`,0o600);store.recover();
if(config.CLIENT_TOKEN)store.registerClient(config.CLIENT_ID,config.CLIENT_NAME,config.CLIENT_TOKEN);
const vault=new Vault(`${config.DATA_DIR}/oauth.key`);
const oauth=new OAuthProvider(store,new URL(config.PUBLIC_URL),vault);
const runner=new Runner(store,config.MAX_CONCURRENCY);
const app=application(store,runner,oauth,config,version,commit);
const server=app.listen(config.PORT,config.HOST,()=>console.log(JSON.stringify({event:'listening',host:config.HOST,port:config.PORT,version,commit})));
server.requestTimeout=30_000;server.headersTimeout=10_000;server.keepAliveTimeout=5_000;
let stopping=false;
async function shutdown():Promise<void> {
  if(stopping)return;stopping=true;
  server.close();await runner.shutdown();server.closeAllConnections();store.db.close();process.exit(0);
}
process.on('SIGTERM',()=>{void shutdown();});process.on('SIGINT',()=>{void shutdown();});
