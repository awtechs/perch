import { z } from 'zod';

export function configuration(environment:NodeJS.ProcessEnv) {
  const config = z.object({
    ADMIN_PASSWORD:z.string().min(24).max(256), CLIENT_TOKEN:z.string().min(32).max(256).optional(),
    CLIENT_ID:z.string().max(256).default('bootstrap'), CLIENT_NAME:z.string().max(256).default('Bootstrap test client'),
    DATA_DIR:z.string().default('./data'), HOST:z.string().default('127.0.0.1'), PORT:z.coerce.number().int().min(1).max(65535).default(8787),
    PUBLIC_URL:z.string().url().default('http://127.0.0.1:8787'), TRUST_PROXY:z.string().default(''),
    MAX_CONCURRENCY:z.coerce.number().int().min(1).max(16).default(4),
  }).parse(environment);
  const publicUrl = new URL(config.PUBLIC_URL);
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname!=='/') throw new Error('PUBLIC_URL must be an origin without credentials, a path, query or fragment');
  if (publicUrl.protocol!=='https:' && !(publicUrl.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(publicUrl.hostname))) throw new Error('Public Perch endpoints require HTTPS');
  return {...config,PUBLIC_URL:publicUrl.origin};
}
export type Configuration = ReturnType<typeof configuration>;
