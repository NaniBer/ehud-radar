import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const environment = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  HOST: z.string().default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  APP_ORIGIN: z.string().url().default('http://127.0.0.1:5174'),
  SESSION_SECRET: z.string().min(32),
  SETUP_TOKEN: z.preprocess((value) => value === '' ? undefined : value, z.string().regex(/^[a-f0-9]{64}$/).optional()),
  TAVILY_API_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().trim().min(1).max(500).optional()),
  SERPER_API_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().trim().min(1).max(500).optional()),
  SEARCH_PROVIDER: z.enum(['serper','tavily']).default('serper'),
  OPENROUTER_API_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().trim().min(1).max(500).optional()),
  OPENROUTER_MODEL: z.enum(['openrouter/free']).default('openrouter/free'),
});

export function readConfig() {
  const parsed = environment.safeParse(process.env);
  if (!parsed.success) {
    // Never include environment values (which may contain secrets) in errors.
    throw new Error(`Check .env settings: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }
  const env = parsed.data;
  const origin = new URL(env.APP_ORIGIN).origin;
  if (env.NODE_ENV === 'production' && !origin.startsWith('https://')) {
    throw new Error('APP_ORIGIN must use HTTPS in production.');
  }
  return {
    port: env.PORT,
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    origin,
    secret: env.SESSION_SECRET,
    production: env.NODE_ENV === 'production',
    setupToken: env.NODE_ENV === 'production' ? undefined : env.SETUP_TOKEN,
    tavilyApiKey: env.TAVILY_API_KEY,
    serperApiKey: env.SERPER_API_KEY,
    searchEngine: env.SEARCH_PROVIDER,
    openRouterApiKey: env.OPENROUTER_API_KEY,
    openRouterModel: env.OPENROUTER_MODEL,
  };
}
