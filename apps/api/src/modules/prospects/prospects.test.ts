import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import pg from 'pg';
import { createApp } from '../../app.js';
import { migrateDatabase } from '../../db/database.js';

const environment = dotenv.parse(readFileSync(new URL('../../../../../.env', import.meta.url)));
const connectionString = process.env.TEST_DATABASE_URL || environment.DATABASE_URL;
const origin = 'http://127.0.0.1:5174';

async function fixture() {
  const schema = `prospects_test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
  await migrateDatabase(pool);
  // Migrations must be repeatable without destroying existing data.
  await migrateDatabase(pool);
  const setupToken = randomBytes(32).toString('hex');
  const application = createApp({ pool, schemaName: schema, origin, secret: randomBytes(32).toString('hex'), setupToken });
  const server = application.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  const base = `http://127.0.0.1:${address.port}/api`;
  let cookie = '';
  let csrf = '';

  async function call(path: string, method = 'GET', body?: unknown, overrides: { origin?: string; csrf?: string; cookie?: string } = {}) {
    const headers: Record<string, string> = { origin: overrides.origin ?? origin };
    if (overrides.cookie ?? cookie) headers.cookie = overrides.cookie ?? cookie;
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers['x-csrf-token'] = overrides.csrf ?? csrf; }
    const result = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = result.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = await result.json();
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: result.status, data };
  }
  return {
    pool, call,
    async signIn() {
      await call('/auth/state');
      assert.equal((await call('/auth/setup', 'POST', { setupToken, password: 'test-only-password-42' })).status, 201);
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      application.store.close();
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}

test('all prospect routes require authentication and writes require both origin and CSRF', async () => {
  const app = await fixture();
  try {
    const id = randomUUID();
    for (const [path, method, body] of [
      ['/prospects', 'GET', undefined], [`/prospects/${id}`, 'GET', undefined],
      ['/prospects', 'POST', { name: 'Test', category: 'agency' }],
      [`/prospects/${id}`, 'PUT', { name: 'Test', category: 'agency', version: 1 }],
    ] as const) assert.equal((await app.call(path, method, body)).status, 401);
    await app.signIn();
    for (const method of ['POST', 'PUT']) {
      const path = method === 'POST' ? '/prospects' : `/prospects/${id}`;
      assert.equal((await app.call(path, method, {}, { origin: 'https://attacker.example' })).status, 403);
      assert.equal((await app.call(path, method, {}, { csrf: '' })).status, 403);
    }
    assert.equal((await app.pool.query('SELECT COUNT(*) FROM prospects')).rows[0].count, '0');
  } finally { await app.close(); }
});

test('create, reopen, and edit preserve source evidence and optional fields in PostgreSQL', async () => {
  const app = await fixture();
  try {
    await app.signIn();
    const created = await app.call('/prospects', 'POST', {
      name: '  Test Agency  ', category: 'agency', website: ' https://agency.example/ ',
      contactName: ' Selam ', email: ' hello@agency.example ', phone: ' +251000 ', location: ' Addis Ababa ',
      relevance: ' Makes music videos ', notes: ' First call next week ',
      sources: [{ title: ' Portfolio ', url: ' https://agency.example/work ', note: ' Commercials ' }],
    });
    assert.equal(created.status, 201);
    const initial = created.data.prospect;
    assert.equal(initial.name, 'Test Agency');
    assert.equal(initial.contactName, 'Selam');
    assert.deepEqual(initial.sources, [{ title: 'Portfolio', url: 'https://agency.example/work', note: 'Commercials' }]);
    assert.equal(initial.version, 1);
    assert.equal(Number.isNaN(Date.parse(initial.createdAt)), false);
    assert.equal(Number.isNaN(Date.parse(initial.updatedAt)), false);
    assert.deepEqual((await app.call(`/prospects/${initial.id}`)).data.prospect, initial);
    const edited = await app.call(`/prospects/${initial.id}`, 'PUT', {
      name: initial.name, category: 'production_company', version: initial.version,
      notes: ' Met at festival ', sources: [{ url: 'https://festival.example/programme' }], website: ' ', email: ' ',
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.prospect.version, 2);
    assert.equal(edited.data.prospect.notes, 'Met at festival');
    assert.equal(edited.data.prospect.email, '');
    assert.equal(edited.data.prospect.website, '');
    assert.equal(edited.data.prospect.location, '');
    assert.equal(edited.data.prospect.createdAt, initial.createdAt);
    assert.deepEqual(edited.data.prospect.sources, [{ title: '', url: 'https://festival.example/programme', note: '' }]);
    assert.deepEqual((await app.call(`/prospects/${initial.id}`)).data.prospect, edited.data.prospect);
    const stored = (await app.pool.query('SELECT notes, sources, version FROM prospects WHERE id = $1', [initial.id])).rows[0];
    assert.equal(stored.notes, 'Met at festival');
    assert.equal(stored.version, 2);
    assert.deepEqual(stored.sources, edited.data.prospect.sources);
  } finally { await app.close(); }
});

test('search, filtering, literal wildcards, and pagination return consistent counts', async () => {
  const app = await fixture();
  try {
    await app.signIn();
    const entries = [
      { name: 'Bright Films', category: 'agency', contactName: 'Selam', location: 'Addis', relevance: 'Cinema', notes: 'Workshop', email: 'hello@bright.example' },
      { name: 'Another Agency', category: 'agency', location: 'Hawassa' },
      { name: 'Creator 100%', category: 'creator', location: 'Addis' },
    ];
    for (const entry of entries) assert.equal((await app.call('/prospects', 'POST', entry)).status, 201);
    const all = await app.call('/prospects?page=1&pageSize=2');
    assert.equal(all.status, 200);
    assert.equal(all.data.total, 3);
    assert.equal(all.data.prospects.length, 2);
    assert.equal(all.data.page, 1);
    assert.equal(all.data.pageSize, 2);
    const second = await app.call('/prospects?page=2&pageSize=2');
    assert.equal(second.data.prospects.length, 1);
    assert.equal(second.data.total, 3);
    assert.equal(new Set([...all.data.prospects, ...second.data.prospects].map((p: { id: string }) => p.id)).size, 3);
    const beyond = await app.call('/prospects?page=20&pageSize=2');
    assert.equal(beyond.data.total, 3);
    assert.deepEqual(beyond.data.prospects, []);
    for (const term of ['BRIGHT', 'SeLaM', 'hello@bright', 'CINEMA', 'workshop']) {
      const found = await app.call(`/prospects?q=${encodeURIComponent(term)}`);
      assert.equal(found.data.total, 1);
      assert.equal(found.data.prospects[0].name, 'Bright Films');
    }
    assert.equal((await app.call('/prospects?q=ADDIS')).data.total, 2);
    assert.equal((await app.call('/prospects?category=agency')).data.total, 2);
    assert.equal((await app.call('/prospects?category=creator&q=Addis')).data.total, 1);
    assert.equal((await app.call('/prospects?q=%25')).data.total, 1);
    assert.equal((await app.call('/prospects?q=_')).data.total, 0);
    assert.equal((await app.call('/prospects?q=%27%20OR%201%3D1%20--')).data.total, 0);
  } finally { await app.close(); }
});

test('validation rejects unsafe URLs, bad IDs, malformed bodies, limits, and invalid queries', async () => {
  const app = await fixture();
  try {
    await app.signIn();
    const valid = { name: 'Valid', category: 'other' };
    const bodies = [
      {}, null, [], { ...valid, name: ' ' }, { ...valid, category: 'invalid' },
      { ...valid, email: 'wrong' }, { ...valid, website: 'javascript:alert(1)' },
      { ...valid, website: 'https://username:password@example.com/' },
      { ...valid, sources: [{ url: 'file:///tmp/test' }] }, { ...valid, sources: [{ url: 'https://ok.example', extra: true }] },
      { ...valid, name: 'x'.repeat(201) }, { ...valid, notes: 'x'.repeat(5001) },
      { ...valid, sources: Array.from({ length: 21 }, () => ({ url: 'https://ok.example' })) },
      { ...valid, version: 1 }, { ...valid, unexpected: 'x' },
    ];
    for (const body of bodies) {
      const result = await app.call('/prospects', 'POST', body);
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(typeof result.data.error, 'string');
    }
    assert.equal((await app.call('/prospects/not-a-uuid')).status, 400);
    assert.equal((await app.call(`/prospects/${randomUUID()}`)).status, 404);
    assert.equal((await app.call(`/prospects/${randomUUID()}`, 'PUT', { ...valid, version: 1 })).status, 404);
    assert.equal((await app.call(`/prospects/${randomUUID()}`, 'PUT', valid)).status, 400);
    for (const query of ['category=bad', 'page=0', 'page=1.5', 'pageSize=101', 'pageSize=nope', 'q=a&q=b', 'extra=x']) {
      assert.equal((await app.call(`/prospects?${query}`)).status, 400, query);
    }
    assert.equal((await app.pool.query('SELECT COUNT(*) FROM prospects')).rows[0].count, '0');
  } finally { await app.close(); }
});

test('duplicate protection is atomic, preserves different profiles, and applies to edits', async () => {
  const app = await fixture();
  try {
    await app.signIn();
    const first = await app.call('/prospects', 'POST', { name: 'Studio One', category: 'agency', location: 'Addis Ababa', website: 'https://www.platform.example/studio-one/?utm_source=feed#bio' });
    assert.equal(first.status, 201);
    assert.equal((await app.call('/prospects', 'POST', { name: 'Different name', category: 'agency', website: 'http://platform.example/studio-one' })).status, 409);
    assert.equal((await app.call('/prospects', 'POST', { name: ' STUDIO   ONE ', category: 'agency', location: ' ADDIS ABABA ' })).status, 409);
    const differentProfile = await app.call('/prospects', 'POST', { name: 'Studio Two', category: 'agency', website: 'https://platform.example/studio-two' });
    assert.equal(differentProfile.status, 201);
    assert.equal((await app.call(`/prospects/${differentProfile.data.prospect.id}`, 'PUT', { name: 'Second', category: 'agency', website: 'https://platform.example/studio-one?fbclid=track', version: 1 })).status, 409);
    assert.equal((await app.call(`/prospects/${differentProfile.data.prospect.id}`)).data.prospect.version, 1);
    const concurrent = await Promise.all([
      app.call('/prospects', 'POST', { name: 'Concurrent A', category: 'brand', website: 'https://brand.example/' }),
      app.call('/prospects', 'POST', { name: 'Concurrent B', category: 'brand', website: 'http://www.brand.example/?gclid=123' }),
    ]);
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [201, 409]);
    const longUrl = 'https://unicode.example/' + 'ዘ'.repeat(1500);
    assert.equal((await app.call('/prospects', 'POST', { name: 'Unicode URL', category: 'other', website: longUrl })).status, 201);
    // Compatibility characters can expand dramatically during normalization;
    // fixed-size duplicate keys must still accept values within field limits.
    const expandingName = 'ﷺ'.repeat(200);
    assert.equal((await app.call('/prospects', 'POST', { name: expandingName, location: expandingName, category: 'other' })).status, 201);
    assert.equal((await app.call('/prospects', 'POST', { name: expandingName, location: expandingName, category: 'other' })).status, 409);
  } finally { await app.close(); }
});

test('optimistic locking allows one concurrent update and rejects stale changes without overwriting', async () => {
  const app = await fixture();
  try {
    await app.signIn();
    const saved = await app.call('/prospects', 'POST', { name: 'Versioned', category: 'creator' });
    const id = saved.data.prospect.id;
    const concurrent = await Promise.all(['First', 'Second'].map((notes) => app.call(`/prospects/${id}`, 'PUT', {
      name: 'Versioned', category: 'creator', version: 1, notes,
    })));
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
    const winner = concurrent.find((result) => result.status === 200)!;
    assert.equal(winner.data.prospect.version, 2);
    assert.equal((await app.call(`/prospects/${id}`, 'PUT', { name: 'Versioned', category: 'creator', version: 1, notes: 'Stale' })).status, 409);
    assert.deepEqual((await app.call(`/prospects/${id}`)).data.prospect, winner.data.prospect);
  } finally { await app.close(); }
});
