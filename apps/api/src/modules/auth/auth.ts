import { randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router, type Request, type Response, type NextFunction } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { rateLimit } from 'express-rate-limit';
import type { Pool } from 'pg';
import { z } from 'zod';

declare module 'express-session' {
  interface SessionData {
    csrfToken?: string;
    accountId?: number;
    authenticatedAt?: number;
  }
}

export const USERNAME = 'ehudaiuser';
const COOKIE_NAME = 'ehud_radar.sid';
const SESSION_DURATION = 8 * 60 * 60 * 1000;

export type AuthOptions = {
  pool: Pool;
  secret: string;
  origin: string;
  production?: boolean;
  setupToken?: string;
  schemaName?: string;
};

export function equalToken(actual: unknown, expected: string | undefined) {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) && !!expected && actual.length === expected.length
    && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function requireAccount(request: Request, response: Response, next: NextFunction) {
  if (request.session.accountId !== 1 || !request.session.authenticatedAt
    || Date.now() - request.session.authenticatedAt >= SESSION_DURATION) {
    response.status(401).json({ error: 'Sign in to continue.' });
    return;
  }
  next();
}

export function protectWrite(origin: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (request.get('origin') !== origin || !equalToken(request.get('x-csrf-token'), request.session.csrfToken)) {
      response.status(403).json({ error: 'Refresh the page and try again.' });
      return;
    }
    next();
  };
}

export function createAuth(options: AuthOptions) {
  const { pool, origin, secret, production = false, setupToken, schemaName = 'public' } = options;
  const PgStore = connectPgSimple(session);
  const store = new PgStore({ pool, schemaName, pruneSessionInterval: options.schemaName ? false : 900 });
  const cookie = { httpOnly: true, secure: production, sameSite: 'strict' as const, path: '/' };
  const sessionMiddleware = session({
    name: COOKIE_NAME,
    secret,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: { ...cookie, maxAge: SESSION_DURATION },
  });

  const router = Router();
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Try again in 15 minutes.' },
  });
  const csrf = protectWrite(origin);

  const credentials = z.object({ username: z.string().max(100), password: z.string().min(1).max(200) }).strict();
  const setup = z.object({
    password: z.string().min(12).refine((value) => Buffer.byteLength(value, 'utf8') <= 72),
    setupToken: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict();
  // A real dummy hash keeps verification work comparable for incorrect usernames.
  const dummyHash = bcrypt.hashSync(randomBytes(32).toString('hex'), 12);

  async function signIn(request: Request) {
    await new Promise<void>((resolve, reject) => request.session.regenerate((error) => error ? reject(error) : resolve()));
    request.session.accountId = 1;
    request.session.authenticatedAt = Date.now();
    request.session.csrfToken = randomBytes(32).toString('hex');
    await new Promise<void>((resolve, reject) => request.session.save((error) => error ? reject(error) : resolve()));
  }

  router.get('/state', async (request, response) => {
    request.session.csrfToken ??= randomBytes(32).toString('hex');
    const result = await pool.query('SELECT username FROM account WHERE id = 1');
    const authenticated = request.session.accountId === 1 && !!request.session.authenticatedAt
      && Date.now() - request.session.authenticatedAt < SESSION_DURATION;
    response.json({
      authenticated,
      username: USERNAME,
      setupRequired: result.rowCount === 0,
      csrfToken: request.session.csrfToken,
    });
  });

  router.post('/setup', limiter, csrf, async (request, response) => {
    const input = setup.safeParse(request.body);
    if (!input.success) {
      response.status(400).json({ error: 'Use a password with at least 12 characters and no more than 72 UTF-8 bytes.' });
      return;
    }
    const loopback = request.socket.remoteAddress === '127.0.0.1' || request.socket.remoteAddress === '::1'
      || request.socket.remoteAddress === '::ffff:127.0.0.1';
    if (production || !loopback || !equalToken(input.data.setupToken, setupToken)) {
      response.status(403).json({ error: 'Account setup is available only through the local setup link.' });
      return;
    }
    const hash = await bcrypt.hash(input.data.password, 12);
    const result = await pool.query(
      'INSERT INTO account (id, username, password_hash) VALUES (1, $1, $2) ON CONFLICT DO NOTHING RETURNING id',
      [USERNAME, hash],
    );
    if (!result.rowCount) {
      response.status(409).json({ error: 'This account is already set up. Sign in with your password.' });
      return;
    }
    await signIn(request);
    response.status(201).json({ username: USERNAME, csrfToken: request.session.csrfToken });
  });

  router.post('/login', limiter, csrf, async (request, response) => {
    const input = credentials.safeParse(request.body);
    if (!input.success) {
      response.status(400).json({ error: 'Enter your username and password.' });
      return;
    }
    const result = await pool.query<{ password_hash: string }>('SELECT password_hash FROM account WHERE id = 1 AND username = $1', [input.data.username]);
    const matches = await bcrypt.compare(input.data.password, result.rows[0]?.password_hash ?? dummyHash);
    if (!result.rowCount || !matches || Buffer.byteLength(input.data.password, 'utf8') > 72) {
      response.status(401).json({ error: 'The username or password is incorrect.' });
      return;
    }
    await signIn(request);
    response.json({ username: USERNAME, csrfToken: request.session.csrfToken });
  });

  router.post('/logout', csrf, (request, response, next) => {
    request.session.destroy((error) => {
      if (error) return next(error);
      response.clearCookie(COOKIE_NAME, cookie);
      response.status(204).end();
    });
  });

  return { router, sessionMiddleware, store };
}
