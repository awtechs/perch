import { randomBytes, randomUUID } from 'node:crypto';
import { type Response } from 'express';
import { z } from 'zod';
import { OAuthClientInformationFullSchema, type OAuthClientInformationFull, type OAuthTokenRevocationRequest, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { type OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { type AuthorizationParams, type OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { type AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { Store, hash } from '../store.js';
import { Vault } from './vault.js';

export const COMMAND_SCOPE = 'vps:commands';
const paramsSchema = z.object({ state: z.string().max(4096).optional(), scopes: z.array(z.string()), codeChallenge: z.string(), redirectUri: z.string().url(), resource: z.string().url() });
const requestSchema = z.object({ id:z.string(), client_id:z.string(), params:z.string(), code_hash:z.string().nullable(), expires:z.number(), consumed:z.number(), approved:z.number() });
const tokenSchema = z.object({ token_hash:z.string(), client_id:z.string(), kind:z.enum(['access','refresh']), family:z.string(), expires:z.number(), revoked:z.number(), resource:z.string() });
export type Consent = { id:string; client:OAuthClientInformationFull; params:z.infer<typeof paramsSchema> };

export class OAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly resource: URL;
  constructor(private readonly store: Store, readonly issuer: URL, private readonly vault:Vault) {
    this.resource = new URL('/mcp', issuer);
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients(id TEXT PRIMARY KEY REFERENCES clients(id),metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_requests(id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),params TEXT NOT NULL,code_hash TEXT UNIQUE,expires INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0,approved INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS oauth_tokens(token_hash TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),kind TEXT NOT NULL,family TEXT NOT NULL,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,resource TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS oauth_token_family ON oauth_tokens(family);
      CREATE INDEX IF NOT EXISTS oauth_token_client ON oauth_tokens(client_id);
    `);
    this.clientsStore = {
      getClient: (id:string):OAuthClientInformationFull|undefined => {
        const row = this.store.db.prepare('SELECT metadata FROM oauth_clients WHERE id=?').get(id);
        if (!row) return undefined;
        const {metadata} = z.object({metadata:z.string()}).parse(row);
        return OAuthClientInformationFullSchema.parse(JSON.parse(this.vault.open(metadata,id)));
      },
      registerClient: (metadata):OAuthClientInformationFull => {
        if (metadata.redirect_uris.length > 10 || (metadata.client_name?.length ?? 0) > 256) throw new InvalidClientMetadataError('Client metadata exceeds limits');
        for (const address of metadata.redirect_uris) {
          const uri = new URL(address);
          if (uri.username || uri.password || uri.hash || (uri.protocol !== 'https:' && !(uri.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(uri.hostname)))) throw new InvalidClientMetadataError('Redirect URI must use HTTPS or a loopback HTTP address');
        }
        const count = z.object({count:z.number()}).parse(this.store.db.prepare('SELECT COUNT(*) AS count FROM oauth_clients').get()).count;
        if (count >= 1000) throw new InvalidClientMetadataError('Client registration limit reached');
        const client = OAuthClientInformationFullSchema.parse({...metadata,client_id:randomUUID(),client_id_issued_at:Math.floor(Date.now()/1000)});
        this.store.transaction(() => {
          this.store.registerClient(client.client_id, client.client_name ?? 'Unnamed OAuth client', randomBytes(32).toString('hex'), false);
          this.store.db.prepare('INSERT INTO oauth_clients(id,metadata) VALUES(?,?)').run(client.client_id, this.vault.seal(JSON.stringify(client),client.client_id));
          this.store.audit('oauth','client_registered',client.client_id);
        });
        return client;
      },
    };
  }
  private target(resource?:URL):void {
    if (resource && resource.href !== this.resource.href) throw new InvalidTargetError('Token resource does not match this Perch instance');
  }
  async authorize(client:OAuthClientInformationFull, params:AuthorizationParams, response:Response):Promise<void> {
    this.target(params.resource);
    const scopes = params.scopes?.length ? params.scopes : [COMMAND_SCOPE];
    if (scopes.some(scope => scope !== COMMAND_SCOPE)) throw new InvalidScopeError('Unsupported scope');
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidGrantError('A valid S256 PKCE challenge is required');
    const id = randomBytes(32).toString('hex');
    this.store.db.prepare('DELETE FROM oauth_requests WHERE expires<?').run(Date.now()-86_400_000);
    const outstanding = z.object({count:z.number()}).parse(this.store.db.prepare('SELECT COUNT(*) AS count FROM oauth_requests WHERE expires>? AND consumed=0').get(Date.now())).count;
    if (outstanding >= 200) throw new InvalidGrantError('Authorization queue is full');
    const saved = paramsSchema.parse({...params,scopes,resource:this.resource.href});
    this.store.db.prepare('INSERT INTO oauth_requests(id,client_id,params,expires) VALUES(?,?,?,?)').run(id,client.client_id,JSON.stringify(saved),Date.now()+600_000);
    response.redirect(303, `/oauth/consent?request=${id}`);
  }
  consent(id:string):Consent {
    const row = this.store.db.prepare('SELECT * FROM oauth_requests WHERE id=?').get(id);
    if (!row) throw new InvalidGrantError('Authorization request not found');
    const request = requestSchema.parse(row);
    if (request.expires < Date.now() || request.consumed || request.approved) throw new InvalidGrantError('Authorization request is no longer pending');
    const client = this.clientsStore.getClient(request.client_id);
    if (!client || client instanceof Promise) throw new InvalidGrantError('Client not found');
    return {id,client,params:paramsSchema.parse(JSON.parse(request.params))};
  }
  decide(id:string, approved:boolean):URL {
    return this.store.transaction(() => {
      const consent = this.consent(id);
      const callback = new URL(consent.params.redirectUri);
      callback.searchParams.set('iss',this.issuer.href);
      if (consent.params.state !== undefined) callback.searchParams.set('state',consent.params.state);
      if (!approved) {
        this.store.db.prepare('UPDATE oauth_requests SET consumed=1 WHERE id=?').run(id);
        callback.searchParams.set('error','access_denied');
        this.store.audit('owner','oauth_denied',consent.client.client_id);
        return callback;
      }
      const code = randomBytes(32).toString('base64url');
      this.store.db.prepare('UPDATE oauth_requests SET code_hash=?,approved=1,expires=? WHERE id=?').run(hash(code),Date.now()+120_000,id);
      this.store.db.prepare('UPDATE clients SET enabled=1 WHERE id=?').run(consent.client.client_id);
      this.store.audit('owner','oauth_granted',consent.client.client_id);
      callback.searchParams.set('code',code); return callback;
    });
  }
  private authorization(client:OAuthClientInformationFull, code:string):z.infer<typeof requestSchema> {
    const row = this.store.db.prepare('SELECT * FROM oauth_requests WHERE code_hash=? AND client_id=?').get(hash(code),client.client_id);
    if (!row) throw new InvalidGrantError('Invalid authorization code');
    const request = requestSchema.parse(row);
    if (!request.approved || request.consumed || request.expires < Date.now() || !this.store.enabled(client.client_id)) throw new InvalidGrantError('Authorization code expired or revoked');
    return request;
  }
  async challengeForAuthorizationCode(client:OAuthClientInformationFull, code:string):Promise<string> {
    return paramsSchema.parse(JSON.parse(this.authorization(client,code).params)).codeChallenge;
  }
  private issue(clientId:string, family:string):OAuthTokens {
    const access = randomBytes(32).toString('base64url'); const refresh = randomBytes(32).toString('base64url'); const now = Date.now();
    const insert = this.store.db.prepare('INSERT INTO oauth_tokens(token_hash,client_id,kind,family,expires,resource) VALUES(?,?,?,?,?,?)');
    insert.run(hash(access),clientId,'access',family,now+3_600_000,this.resource.href);
    insert.run(hash(refresh),clientId,'refresh',family,now+30*86_400_000,this.resource.href);
    return {access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600,scope:COMMAND_SCOPE};
  }
  async exchangeAuthorizationCode(client:OAuthClientInformationFull, code:string, _verifier?:string, redirectUri?:string, resource?:URL):Promise<OAuthTokens> {
    this.target(resource);
    return this.store.transaction(() => {
      const request = this.authorization(client,code); const params = paramsSchema.parse(JSON.parse(request.params));
      if (redirectUri !== params.redirectUri) throw new InvalidGrantError('Redirect URI does not match authorization');
      const changed = this.store.db.prepare('UPDATE oauth_requests SET consumed=1 WHERE id=? AND consumed=0').run(request.id);
      if (changed.changes !== 1) throw new InvalidGrantError('Authorization code already consumed');
      this.store.audit('oauth','token_issued',client.client_id);
      return this.issue(client.client_id,randomUUID());
    });
  }
  async exchangeRefreshToken(client:OAuthClientInformationFull, refresh:string, scopes?:string[], resource?:URL):Promise<OAuthTokens> {
    this.target(resource);
    if (scopes?.some(scope=>scope!==COMMAND_SCOPE)) throw new InvalidScopeError('Requested scope exceeds the grant');
    const row = this.store.db.prepare('SELECT * FROM oauth_tokens WHERE token_hash=? AND client_id=? AND kind=?').get(hash(refresh),client.client_id,'refresh');
    if (!row) throw new InvalidGrantError('Invalid refresh token');
    const token = tokenSchema.parse(row);
    if (token.revoked) {
      this.store.db.prepare('UPDATE oauth_tokens SET revoked=1 WHERE family=?').run(token.family);
      this.store.audit('oauth','refresh_replay_revoked',client.client_id);
      throw new InvalidGrantError('Refresh token reuse detected; reconnect this client');
    }
    if (token.expires<Date.now() || token.resource!==this.resource.href || !this.store.enabled(client.client_id)) throw new InvalidGrantError('Refresh token expired or revoked');
    return this.store.transaction(() => {
      this.store.db.prepare('UPDATE oauth_tokens SET revoked=1 WHERE token_hash=?').run(token.token_hash);
      return this.issue(client.client_id,token.family);
    });
  }
  async verifyAccessToken(value:string):Promise<AuthInfo> {
    const staticClient = this.store.authenticate(value);
    if (staticClient) return {token:value,clientId:staticClient,scopes:[COMMAND_SCOPE],resource:this.resource};
    const row = this.store.db.prepare('SELECT * FROM oauth_tokens WHERE token_hash=? AND kind=?').get(hash(value),'access');
    if (!row) throw new InvalidTokenError('Invalid access token');
    const token = tokenSchema.parse(row);
    if (token.revoked || token.expires<Date.now() || token.resource!==this.resource.href || !this.store.enabled(token.client_id)) throw new InvalidTokenError('Access token expired or revoked');
    return {token:value,clientId:token.client_id,scopes:[COMMAND_SCOPE],expiresAt:Math.floor(token.expires/1000),resource:this.resource};
  }
  async revokeToken(client:OAuthClientInformationFull, request:OAuthTokenRevocationRequest):Promise<void> {
    const row = this.store.db.prepare('SELECT family FROM oauth_tokens WHERE token_hash=? AND client_id=?').get(hash(request.token),client.client_id);
    if (row) { const {family} = z.object({family:z.string()}).parse(row); this.store.db.prepare('UPDATE oauth_tokens SET revoked=1 WHERE family=?').run(family); }
    this.store.audit('oauth','token_revoked',client.client_id);
  }
  revokeClient(id:string):void {
    this.store.setClientEnabled(id,false);
    this.store.db.prepare('UPDATE oauth_tokens SET revoked=1 WHERE client_id=?').run(id);
  }
}
