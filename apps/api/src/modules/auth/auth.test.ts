import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app.js';
import { migrateDatabase } from '../../db/database.js';
import { equalToken } from './auth.js';

const environment = dotenv.parse(readFileSync(new URL('../../../../../.env', import.meta.url)));
const connectionString = process.env.TEST_DATABASE_URL || environment.DATABASE_URL;
const password = 'test-only-password-42';

async function fixture(production = false) {
  const schema = `auth_test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
  await migrateDatabase(pool);
  const token = randomBytes(32).toString('hex');
  const origin = production ? 'https://radar.example' : 'http://127.0.0.1:5174';
  const options = { pool, schemaName: schema, secret: randomBytes(32).toString('hex'), origin, production, setupToken: token };
  const running: Array<ReturnType<typeof createApp> & { server: ReturnType<ReturnType<typeof createApp>['app']['listen']> }> = [];

  async function start() {
    const app = createApp(options);
    const server = app.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    running.push({ ...app, server });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test server address');
    return `http://127.0.0.1:${address.port}`;
  }
  let base = await start();
  let cookie = '';
  let csrf = '';

  async function call(path: string, body?: object, overrides: { origin?: string; csrf?: string; cookie?: string } = {}) {
    const headers: Record<string, string> = { origin: overrides.origin ?? origin };
    if (production) headers['x-forwarded-proto'] = 'https';
    if (overrides.cookie ?? cookie) headers.cookie = overrides.cookie ?? cookie;
    if (body) { headers['content-type'] = 'application/json'; headers['x-csrf-token'] = overrides.csrf ?? csrf; }
    const response = await fetch(`${base}/api${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = response.status === 204 ? null : await response.json();
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: response.status, headers: response.headers, data, cookie };
  }

  return {
    pool, token, call,
    async setup() { await call('/auth/state'); return call('/auth/setup', { password, setupToken: token }); },
    async restart() {
      const previous = running.at(-1)!;
      await new Promise<void>((resolve) => previous.server.close(() => resolve()));
      base = await start();
    },
    async close() {
      for (const item of running) {
        await new Promise<void>((resolve) => item.server.close(() => resolve()));
        item.store.close();
      }
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}

test('setup is protected, stores a hash, rotates the session, and cannot overwrite the account', async () => {
  const app = await fixture();
  try {
    assert.equal((await app.call('/dashboard')).status, 401);
    const initial = await app.call('/auth/state');
    assert.equal(initial.data.setupRequired, true);
    assert.equal((await app.call('/auth/setup', { password, setupToken: '0'.repeat(64) })).status, 403);
    assert.equal((await app.call('/auth/setup', { password: 'short', setupToken: app.token })).status, 400);
    assert.equal((await app.call('/auth/setup', { password: 'é'.repeat(40), setupToken: app.token })).status, 400);
    const result = await app.call('/auth/setup', { password, setupToken: app.token });
    assert.equal(result.status, 201);
    assert.notEqual(result.cookie, initial.cookie);
    assert.notEqual(result.data.csrfToken, initial.data.csrfToken);
    assert.match(result.headers.get('set-cookie')!, /HttpOnly/);
    assert.match(result.headers.get('set-cookie')!, /SameSite=Strict/);
    const account = (await app.pool.query('SELECT * FROM account')).rows[0];
    assert.equal(account.username, 'ehudaiuser');
    assert.notEqual(account.password_hash, password);
    assert.equal(await bcrypt.compare(password, account.password_hash), true);
    assert.equal((await app.call('/dashboard')).status, 200);
    assert.equal((await app.call('/auth/setup', { password: 'different-password', setupToken: app.token })).status, 409);
    assert.equal((await app.pool.query('SELECT COUNT(*) FROM account')).rows[0].count, '1');
    assert.equal((await app.call('/auth/state')).data.setupRequired, false);
  } finally { await app.close(); }
});

test('login rejects wrong credentials, survives an API restart, and logout revokes the session', async () => {
  const app = await fixture();
  try {
    await app.setup();
    await app.call('/auth/logout', {});
    const initial = await app.call('/auth/state');
    assert.equal((await app.call('/auth/login', { username: 'ehudaiuser', password: 'wrong-password' })).status, 401);
    assert.equal((await app.call('/auth/login', { username: "' OR 1=1 --", password })).status, 401);
    const loggedIn = await app.call('/auth/login', { username: 'ehudaiuser', password });
    assert.equal(loggedIn.status, 200);
    assert.notEqual(loggedIn.cookie, initial.cookie);
    await app.restart();
    assert.equal((await app.call('/auth/state')).data.authenticated, true);
    assert.equal((await app.call('/dashboard')).status, 200);
    assert.equal((await app.call('/auth/logout', {}, { csrf: '' })).status, 403);
    assert.equal((await app.call('/auth/logout', {}, { origin: 'https://another.example' })).status, 403);
    assert.equal((await app.call('/auth/logout', {})).status, 204);
    assert.equal((await app.call('/dashboard', undefined, { cookie: loggedIn.cookie })).status, 401);
  } finally { await app.close(); }
});

test('sessions expire after eight hours even if their database cookie expiry is extended', async () => {
  const app = await fixture();
  try {
    await app.setup();
    await app.pool.query("UPDATE session SET sess = jsonb_set(sess::jsonb, '{authenticatedAt}', to_jsonb($1::bigint))::json", [Date.now() - 9 * 60 * 60 * 1000]);
    assert.equal((await app.call('/dashboard')).status, 401);
    assert.equal((await app.call('/auth/state')).data.authenticated, false);
  } finally { await app.close(); }
});

test('production uses secure cookies and disables browser account setup', async () => {
  const app = await fixture(true);
  try {
    const initial = await app.call('/auth/state');
    assert.match(initial.headers.get('set-cookie')!, /Secure/);
    assert.equal((await app.call('/auth/setup', { password, setupToken: app.token })).status, 403);
    assert.equal((await app.pool.query('SELECT COUNT(*) FROM account')).rows[0].count, '0');
  } finally { await app.close(); }
});

test('repeated authentication attempts are limited', async () => {
  const app = await fixture();
  try {
    await app.call('/auth/state');
    for (let attempt = 0; attempt < 10; attempt++) {
      assert.equal((await app.call('/auth/login', { username: 'ehudaiuser', password: 'wrong' })).status, 401);
    }
    assert.equal((await app.call('/auth/login', { username: 'ehudaiuser', password: 'wrong' })).status, 429);
  } finally { await app.close(); }
});

test('token comparison safely rejects malformed and Unicode inputs', () => {
  const token = 'a'.repeat(64);
  assert.equal(equalToken(token, token), true);
  assert.equal(equalToken('é'.repeat(64), token), false);
  assert.equal(equalToken(undefined, token), false);
  assert.equal(equalToken('b'.repeat(64), token), false);
});
