import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { protectWrite, requireAccount, type AuthOptions } from '../auth/auth.js';
import { addProspect, categories, prospect, prospectInput, textKey, websiteKey } from '../prospects/prospects.js';
import { DiscoveryError, type Assessor, type SearchProvider, type SearchResult } from './providers.js';

export type DiscoveryOptions = AuthOptions & { searchProvider?: SearchProvider; assessor?: Assessor; searchEngine?: 'serper'|'tavily' };
const DAILY_LIMIT = 20;
const runInput = z.object({
  requestId: z.uuid(), category: z.enum(categories), location: z.string().trim().min(1).max(200),
  keywords: z.string().trim().max(200).default(''), limit: z.number().int().min(1).max(10).default(5),
}).strict();
const labels: Record<typeof categories[number], string> = {
  agency: 'creative advertising agencies', production_company: 'film production companies',
  filmmaker: 'filmmakers', creator: 'content creators', brand: 'brands companies',
  education: 'film media training schools', community: 'film creative communities', other: 'creative organizations',
};
const resultInput = z.object({ title: z.string(), content: z.string(), url: z.string().max(2000).refine(value => {
  try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}) });
const iso = (value: Date | string | null) => value ? new Date(value).toISOString() : null;
function run(row: any) {
  return { id: row.id, category: row.category, location: row.location, keywords: row.keywords, query: row.query,
    limit: row.result_limit, provider: row.provider, status: row.status, error: row.error_message,
    createdAt: iso(row.created_at), completedAt: iso(row.completed_at),
    candidateCount: Number(row.candidate_count || 0), savedCount: Number(row.saved_count || 0) };
}
function candidate(row: any) {
  return { id: row.id, runId: row.run_id, title: row.title, url: row.url, snippet: row.snippet,
    dismissed: row.dismissed, savedProspectId: row.saved_prospect_id, existingProspectId: row.existing_prospect_id || null,
    assessment: row.result || null, assessmentStatus: row.assessment_status || 'idle', assessmentError: row.assessment_error || '' };
}
async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await operation(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function lock(client: PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('discovery'))");
}
async function expire(database: Pool | PoolClient) {
  await database.query(`UPDATE discovery_runs SET status='failed', error_message='This search was interrupted. Run a new search.', completed_at=NOW()
    WHERE status='running' AND created_at < NOW() - INTERVAL '2 minutes'`);
  await database.query(`UPDATE discovery_assessments SET status='failed', error_message='This assessment was interrupted. Try again.', completed_at=NOW()
    WHERE status='running' AND created_at < NOW() - INTERVAL '2 minutes'`);
}
const runSelect = `SELECT r.*, (SELECT COUNT(*) FROM discovery_candidates WHERE run_id=r.id) AS candidate_count,
  (SELECT COUNT(*) FROM discovery_candidates WHERE run_id=r.id AND saved_prospect_id IS NOT NULL) AS saved_count FROM discovery_runs r`;
const candidateSelect = `SELECT c.*, (SELECT id FROM prospects WHERE website_key=c.url_key LIMIT 1) AS existing_prospect_id,
  a.result, a.status AS assessment_status, a.error_message AS assessment_error
  FROM discovery_candidates c LEFT JOIN LATERAL (
    SELECT * FROM discovery_assessments WHERE candidate_id=c.id ORDER BY created_at DESC, id DESC LIMIT 1
  ) a ON TRUE`;
async function detail(pool: Pool, id: string) {
  const runs = await pool.query(`${runSelect} WHERE r.id=$1`, [id]);
  if (!runs.rowCount) throw new DiscoveryError('This search could not be found.', 404);
  const candidates = await pool.query(`${candidateSelect} WHERE c.run_id=$1 ORDER BY c.position`, [id]);
  return { run: run(runs.rows[0]), candidates: candidates.rows.map(candidate) };
}
async function candidateDetail(pool: Pool, id: string) {
  const result = await pool.query(`${candidateSelect} WHERE c.id=$1`, [id]);
  if (!result.rowCount) throw new DiscoveryError('This candidate could not be found.', 404);
  return candidate(result.rows[0]);
}

export function createDiscovery({ pool, origin, searchProvider, assessor, searchEngine = 'serper' }: DiscoveryOptions) {
  const router = Router();
  router.use(requireAccount);
  router.param('id', (_request, response, next, value) => {
    if (!z.uuid().safeParse(value).success) { response.status(400).json({ error: 'Use a valid discovery ID.' }); return; }
    next();
  });
  router.get('/state', async (_request, response) => {
    await expire(pool);
    const used = await pool.query(`SELECT
      (SELECT COUNT(*) FROM discovery_runs WHERE created_at > NOW() - INTERVAL '24 hours') AS searches,
      (SELECT COUNT(*) FROM discovery_assessments WHERE created_at > NOW() - INTERVAL '24 hours') AS assessments`);
    response.json({ searchReady: !!searchProvider, searchProvider: searchProvider?.name || (searchEngine === 'tavily' ? 'Tavily' : 'Serper'),
      aiReady: !!assessor, aiModel: assessor?.model || null, dailyLimit: DAILY_LIMIT,
      searchesRemaining: Math.max(0, DAILY_LIMIT - Number(used.rows[0].searches)),
      assessmentsRemaining: Math.max(0, DAILY_LIMIT - Number(used.rows[0].assessments)) });
  });
  router.get('/runs', async (request, response) => {
    const parsed = z.object({ page: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().max(100000)).default(1) }).strict().safeParse(request.query);
    if (!parsed.success) { response.status(400).json({ error: 'Use a valid search history page.' }); return; }
    await expire(pool);
    const page = parsed.data.page;
    const result = await pool.query(`WITH matches AS MATERIALIZED (${runSelect})
      SELECT (SELECT COUNT(*) FROM matches)::int AS total,
      COALESCE((SELECT json_agg(p) FROM (SELECT * FROM matches ORDER BY created_at DESC, id DESC LIMIT 20 OFFSET $1) p), '[]'::json) AS rows`, [(page - 1) * 20]);
    response.json({ runs: result.rows[0].rows.map(run), total: result.rows[0].total, page, pageSize: 20 });
  });
  router.get('/runs/:id', async (request, response) => { await expire(pool); response.json(await detail(pool, String(request.params.id))); });

  router.post('/runs', protectWrite(origin), async (request, response) => {
    const parsed = runInput.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: 'Choose a category, enter a location, and request 1–10 results.' }); return; }
    if (!searchProvider) throw new DiscoveryError('Connect a web search API in the backend configuration to run Discovery.', 503);
    const data = parsed.data;
    const query = [labels[data.category], data.location, data.keywords].filter(Boolean).join(' ');
    const started = await transaction(pool, async client => {
      await lock(client); await expire(client);
      const existing = await client.query('SELECT * FROM discovery_runs WHERE id=$1', [data.requestId]);
      if (existing.rowCount) {
        const prior = existing.rows[0];
        if (prior.query !== query || prior.result_limit !== data.limit) throw new DiscoveryError('This request ID belongs to a different search.', 409);
        return false;
      }
      const used = await client.query("SELECT COUNT(*) FROM discovery_runs WHERE created_at > NOW() - INTERVAL '24 hours'");
      if (Number(used.rows[0].count) >= DAILY_LIMIT) throw new DiscoveryError('The 20-search daily limit is reached. Try again tomorrow.', 429);
      if ((await client.query("SELECT id FROM discovery_runs WHERE status='running'")).rowCount) throw new DiscoveryError('A search is already running. Open search history to follow it.', 409);
      await client.query(`INSERT INTO discovery_runs (id,category,location,keywords,query,result_limit,provider,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'running')`, [data.requestId,data.category,data.location,data.keywords,query,data.limit,searchProvider.name]);
      return true;
    });
    if (!started) { response.json(await detail(pool, data.requestId)); return; }
    try {
      const results = await searchProvider.search(query, data.limit);
      const seen = new Set<string>();
      const clean: (SearchResult & { key: string })[] = [];
      for (const result of results.slice(0,100)) {
        const valid = resultInput.safeParse(result);
        if (!valid.success) continue;
        const key = websiteKey(valid.data.url);
        if (seen.has(key)) continue;
        seen.add(key);
        clean.push({ title: (valid.data.title.trim() || new URL(valid.data.url).hostname).slice(0,200),
          url: valid.data.url, content: valid.data.content.trim().slice(0,6000), key });
        if (clean.length >= data.limit) break;
      }
      await transaction(pool, async client => {
        const locked = await client.query("SELECT status FROM discovery_runs WHERE id=$1 FOR UPDATE", [data.requestId]);
        if (locked.rows[0]?.status !== 'running') return;
        for (const [position, item] of clean.entries()) await client.query(`INSERT INTO discovery_candidates
          (id,run_id,title,url,url_key,snippet,position) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(),data.requestId,item.title,item.url,item.key,item.content,position]);
        await client.query("UPDATE discovery_runs SET status='completed', completed_at=NOW() WHERE id=$1", [data.requestId]);
      });
    } catch (error) {
      const message = error instanceof DiscoveryError ? error.message : 'Search could not finish. Try a new search later.';
      await pool.query("UPDATE discovery_runs SET status='failed',error_message=$2,completed_at=NOW() WHERE id=$1 AND status='running'", [data.requestId,message]);
    }
    response.status(201).json(await detail(pool, data.requestId));
  });

  router.post('/candidates/:id/dismiss', protectWrite(origin), async (request, response) => {
    const parsed = z.object({ dismissed: z.boolean() }).strict().safeParse(request.body);
    if (!parsed.success) throw new DiscoveryError('Choose whether to dismiss this candidate.', 400);
    await pool.query('UPDATE discovery_candidates SET dismissed=$2 WHERE id=$1', [request.params.id,parsed.data.dismissed]);
    response.json({ candidate: await candidateDetail(pool,String(request.params.id)) });
  });

  router.post('/candidates/:id/save', protectWrite(origin), async (request, response) => {
    const parsed = z.object({ fields: prospectInput }).strict().safeParse(request.body);
    if (!parsed.success) throw new DiscoveryError('Check the prospect details and source links before saving.', 400);
    const result = await transaction(pool, async client => {
      const found = await client.query('SELECT * FROM discovery_candidates WHERE id=$1 FOR UPDATE', [request.params.id]);
      if (!found.rowCount) throw new DiscoveryError('This candidate could not be found.', 404);
      const item = found.rows[0];
      if (item.saved_prospect_id) {
        const saved = await client.query('SELECT * FROM prospects WHERE id=$1', [item.saved_prospect_id]);
        return { prospect: prospect(saved.rows[0]), existing: true };
      }
      const fields = parsed.data.fields;
      fields.sources = [{ title: item.title, url: item.url, note: item.snippet.slice(0,1000) }, ...fields.sources.filter(source => websiteKey(source.url) !== item.url_key)];
      if (fields.sources.length > 20) throw new DiscoveryError('Leave room for the original search source: use at most 19 other sources.', 400);
      let saved;
      let existing = false;
      await client.query('SAVEPOINT create_prospect');
      try { saved = await addProspect(client, fields); }
      catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== '23505') throw error;
        await client.query('ROLLBACK TO SAVEPOINT create_prospect');
        const match = await client.query(`SELECT * FROM prospects WHERE
          (website_key <> '' AND website_key=$1) OR (name_key=$2 AND location_key=$3) ORDER BY created_at LIMIT 1`,
          [websiteKey(fields.website),textKey(fields.name),textKey(fields.location)]);
        if (!match.rowCount) throw error;
        saved = prospect(match.rows[0]); existing = true;
      }
      await client.query('UPDATE discovery_candidates SET saved_prospect_id=$2,dismissed=FALSE WHERE id=$1', [item.id,saved.id]);
      return { prospect: saved, existing };
    });
    response.json(result);
  });

  router.post('/candidates/:id/assess', protectWrite(origin), async (request, response) => {
    if (!z.object({}).strict().safeParse(request.body).success) throw new DiscoveryError('Submit an empty assessment request.', 400);
    if (!assessor) throw new DiscoveryError('Add OPENROUTER_API_KEY to the backend configuration to assess fit.', 503);
    const reservation = await transaction(pool, async client => {
      await lock(client); await expire(client);
      const found = await client.query('SELECT c.*,r.category,r.location FROM discovery_candidates c JOIN discovery_runs r ON r.id=c.run_id WHERE c.id=$1', [request.params.id]);
      if (!found.rowCount) throw new DiscoveryError('This candidate could not be found.', 404);
      const prior = await client.query("SELECT * FROM discovery_assessments WHERE candidate_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [request.params.id]);
      if (prior.rows[0]?.status === 'completed') return null;
      if (prior.rows[0]?.status === 'running') throw new DiscoveryError('This assessment is already running.', 409);
      const used = await client.query("SELECT COUNT(*) FROM discovery_assessments WHERE created_at > NOW() - INTERVAL '24 hours'");
      if (Number(used.rows[0].count) >= DAILY_LIMIT) throw new DiscoveryError('The 20-assessment daily limit is reached. Review the source manually or try tomorrow.', 429);
      const id = randomUUID();
      await client.query("INSERT INTO discovery_assessments (id,candidate_id,status) VALUES ($1,$2,'running')", [id,request.params.id]);
      return { id, item: found.rows[0] };
    });
    if (reservation) {
      try {
        const { item } = reservation;
        const result = await assessor.assess({title:item.title,url:item.url,content:item.snippet},item.category,item.location);
        await pool.query("UPDATE discovery_assessments SET status='completed',result=$2::jsonb,completed_at=NOW() WHERE id=$1 AND status='running'", [reservation.id,JSON.stringify(result)]);
      } catch (error) {
        const message = error instanceof DiscoveryError ? error.message : 'AI could not finish. Review the source manually.';
        await pool.query("UPDATE discovery_assessments SET status='failed',error_message=$2,completed_at=NOW() WHERE id=$1 AND status='running'", [reservation.id,message]);
      }
    }
    response.json({ candidate: await candidateDetail(pool,String(request.params.id)) });
  });
  return router;
}
