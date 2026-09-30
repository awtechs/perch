import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { z } from 'zod';

export class Vault {
  private readonly key:Buffer;
  constructor(path:string) {
    try { writeFileSync(path,randomBytes(32),{flag:'wx',mode:0o600}); }
    catch(error) { if (!(error instanceof Error && 'code' in error && error.code==='EEXIST')) throw error; }
    if ((statSync(path).mode & 0o077)!==0) throw new Error('OAuth key file must not be accessible to other users');
    this.key=readFileSync(path);if(this.key.length!==32)throw new Error('OAuth key must contain exactly 32 bytes');
  }
  seal(value:string,context:string):string {
    const nonce=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',this.key,nonce);cipher.setAAD(Buffer.from(context));
    const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    return JSON.stringify({nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});
  }
  open(value:string,context:string):string {
    const saved=z.object({nonce:z.string(),tag:z.string(),data:z.string()}).parse(JSON.parse(value));
    const decipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(saved.nonce,'base64'));
    decipher.setAAD(Buffer.from(context));decipher.setAuthTag(Buffer.from(saved.tag,'base64'));
    return Buffer.concat([decipher.update(Buffer.from(saved.data,'base64')),decipher.final()]).toString('utf8');
  }
}
