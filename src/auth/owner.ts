import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { type Request, type Response, type RequestHandler } from 'express';
import { z } from 'zod';
import { hash } from '../store.js';
import { page, escape } from '../http/views.js';

type Session = {csrf:string;expires:number;authenticated:boolean};
export class Owner {
  private readonly sessions = new Map<string,Session>();
  private readonly attempts = new Map<string,{count:number;expires:number}>();
  private readonly salt = randomBytes(32);
  private readonly passwordHash:Buffer;
  constructor(password:string, private readonly secure:boolean) { this.passwordHash=scryptSync(password,this.salt,32); }
  private cookie(req:Request):string|undefined { return req.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith('perch_owner='))?.slice(12); }
  get(req:Request):Session|undefined {
    const cookie=this.cookie(req); if (!cookie) return undefined;
    const session=this.sessions.get(hash(cookie));
    if (session && session.expires>Date.now()) return session;
    this.sessions.delete(hash(cookie)); return undefined;
  }
  private create(res:Response, authenticated:boolean):Session {
    for (const [id,value] of this.sessions) if (value.expires<Date.now()) this.sessions.delete(id);
    if (this.sessions.size>=100) {
      const guest=[...this.sessions.entries()].find(([,session])=>!session.authenticated);
      if(guest)this.sessions.delete(guest[0]);else throw new Error('Owner session limit reached');
    }
    const token=randomBytes(32).toString('hex');
    const session={csrf:randomBytes(32).toString('hex'),expires:Date.now()+3_600_000,authenticated};
    this.sessions.set(hash(token),session);
    res.setHeader('Set-Cookie',`perch_owner=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${this.secure?'; Secure':''}`);
    return session;
  }
  private next(req:Request):string {
    const raw=z.object({next:z.string().max(512).optional()}).safeParse(req.method==='GET'?req.query:req.body);
    const next=raw.success?raw.data.next:undefined;
    return next && /^\/oauth\/consent\?request=[a-f0-9]{64}$/.test(next)?next:'/approvals';
  }
  loginPage:RequestHandler = (req,res):void => {
    const session=this.get(req)??this.create(res,false);
    res.send(page(`<h1>Owner sign-in</h1><form method="post" action="/login"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="next" value="${escape(this.next(req))}"><label>Owner password <input name="password" type="password" required autocomplete="current-password" maxlength="256"></label><button>Sign in</button></form>`));
  };
  login:RequestHandler = (req,res):void => {
    const session=this.get(req); const parsed=z.object({password:z.string().max(256),csrf:z.string()}).safeParse(req.body);
    if (!session || !parsed.success || session.csrf!==parsed.data.csrf) { res.status(403).send('Invalid sign-in session'); return; }
    const now=Date.now();
    for (const [key,value] of this.attempts) if (value.expires<now) this.attempts.delete(key);
    const key=req.ip??req.socket.remoteAddress??'unknown'; const previous=this.attempts.get(key);
    if ((previous?.count??0)>=5 || this.attempts.size>=4096) {res.status(429).set('Retry-After','900').send('Try again later');return;}
    if (!timingSafeEqual(scryptSync(parsed.data.password,this.salt,32),this.passwordHash)) {
      this.attempts.set(key,{count:(previous?.count??0)+1,expires:previous?.expires??now+900_000});res.status(401).send('Invalid password');return;
    }
    this.attempts.delete(key);
    const old=this.cookie(req); if(old) this.sessions.delete(hash(old));
    this.create(res,true);res.redirect(303,this.next(req));
  };
  require:RequestHandler = (req,res,next):void => {
    const session=this.get(req);
    if (!session?.authenticated) {res.redirect(303,`/login?next=${encodeURIComponent(/^\/oauth\/consent\?request=[a-f0-9]{64}$/.test(req.originalUrl)?req.originalUrl:'/approvals')}`);return;}
    if (req.method==='POST') {
      const parsed=z.object({csrf:z.string()}).safeParse(req.body);
      if (!parsed.success || parsed.data.csrf!==session.csrf) {res.status(403).send('Invalid approval session');return;}
    }
    next();
  };
  logout:RequestHandler = (req,res):void => {
    const old=this.cookie(req);if(old)this.sessions.delete(hash(old));
    res.setHeader('Set-Cookie',`perch_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${this.secure?'; Secure':''}`);res.redirect(303,'/login');
  };
}
