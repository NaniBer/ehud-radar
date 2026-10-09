import { createHash, randomUUID } from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { protectWrite, requireAccount, type AuthOptions } from '../auth/auth.js';

export const categories = ['agency', 'production_company', 'filmmaker', 'creator', 'brand', 'education', 'community', 'other'] as const;
const text = (max: number) => z.string().trim().max(max).default('');
const webUrl = z.string().trim().max(2000).refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}, 'Use a complete HTTP or HTTPS URL without embedded credentials.');
export const prospectInput = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(categories),
  website: z.string().trim().pipe(z.union([z.literal(''), webUrl])).default(''),
  contactName: text(200),
  email: z.string().trim().pipe(z.union([z.literal(''), z.string().max(254).email()])).default(''),
  phone: text(100),
  location: text(200),
  relevance: text(2000),
  notes: text(5000),
  sources: z.array(z.object({ title: text(200), url: webUrl, note: text(1000) }).strict()).max(20).default([]),
}).strict();
const updateInput = prospectInput.extend({ version: z.number().int().min(1).max(2147483646) });
const pagination = z.object({
  q: z.string().trim().max(200).default(''),
  category: z.union([z.literal(''), z.enum(categories)]).optional(),
  page: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(1000000)).default(1),
  pageSize: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(100)).default(25),
}).strict();

export type ProspectInput = z.infer<typeof prospectInput>;
type ProspectRow = {
  id: string; name: string; category: typeof categories[number]; website: string;
  contact_name: string; email: string; phone: string; location: string; relevance: string;
  notes: string; sources: ProspectInput['sources']; version: number;
  created_at: Date | string; updated_at: Date | string;
};

export function prospect(row: ProspectRow) {
  return {
    id: row.id, name: row.name, category: row.category, website: row.website,
    contactName: row.contact_name, email: row.email, phone: row.phone, location: row.location,
    relevance: row.relevance, notes: row.notes, sources: row.sources, version: row.version,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function textKey(value: string) {
  const normalized = value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

// Retain full profile paths and meaningful query parameters: two profiles on the
// same social platform are different prospects, while marketing tags are not.
export function websiteKey(value: string) {
  if (!value) return '';
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(fbclid|gclid|msclkid|dclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  const path = url.pathname.replace(/\/+$/, '');
  const canonical = url.hostname.toLowerCase().replace(/^www\./, '') + (url.port ? `:${url.port}` : '')
    + path + (url.searchParams.size ? `?${url.searchParams}` : '');
  // Fixed-size keys avoid PostgreSQL index limits for long Unicode URLs.
  return createHash('sha256').update(canonical).digest('hex');
}

function values(data: ProspectInput) {
  return [data.name, data.category, data.website, websiteKey(data.website), textKey(data.name), textKey(data.location),
    data.contactName, data.email, data.phone, data.location, data.relevance, data.notes, JSON.stringify(data.sources)];
}

export async function addProspect(database: Pool | PoolClient, data: ProspectInput) {
  const result = await database.query<ProspectRow>(`
    INSERT INTO prospects (id, name, category, website, website_key, name_key, location_key,
      contact_name, email, phone, location, relevance, notes, sources)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb) RETURNING *
  `, [randomUUID(), ...values(data)]);
  return prospect(result.rows[0]);
}

function invalid(response: Response, error: z.ZodError) {
  const issue = error.issues[0];
  response.status(400).json({ error: `Check ${issue.path.join('.') || 'the submitted fields'}: ${issue.message}` });
}

function duplicate(response: Response, error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== '23505') return false;
  const website = 'constraint' in error && error.constraint === 'prospects_website_unique';
  response.status(409).json({ error: website
    ? 'A prospect with this website is already saved. Open the existing prospect instead.'
    : 'A prospect with this name and location is already saved. Open the existing prospect instead.' });
  return true;
}

export function createProspects({ pool, origin }: AuthOptions) {
  const router = Router();
  router.use(requireAccount);
  router.param('id', (request, response, next, value) => {
    if (!z.uuid().safeParse(value).success) {
      response.status(400).json({ error: 'Use a valid prospect ID.' });
      return;
    }
    next();
  });

  router.get('/', async (request, response) => {
    const parsed = pagination.safeParse(request.query);
    if (!parsed.success) return invalid(response, parsed.error);
    const { q, category, page, pageSize } = parsed.data;
    // Treat percent/underscore as literal search characters, not SQL wildcards.
    const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const result = await pool.query<{ total: string; rows: ProspectRow[] }>(`
      WITH matches AS MATERIALIZED (
        SELECT * FROM prospects
        WHERE ($1 = '' OR name ILIKE $2 OR contact_name ILIKE $2 OR email ILIKE $2
          OR location ILIKE $2 OR relevance ILIKE $2 OR notes ILIKE $2)
          AND ($3 = '' OR category = $3)
      )
      SELECT (SELECT COUNT(*) FROM matches)::text AS total,
        COALESCE((SELECT json_agg(page_rows) FROM (
          SELECT * FROM matches ORDER BY updated_at DESC, id LIMIT $4 OFFSET $5
        ) page_rows), '[]'::json) AS rows
    `, [q, pattern, category ?? '', pageSize, (page - 1) * pageSize]);
    response.json({ prospects: result.rows[0].rows.map(prospect), total: Number(result.rows[0].total), page, pageSize });
  });

  router.get('/:id', async (request, response) => {
    const result = await pool.query<ProspectRow>('SELECT * FROM prospects WHERE id = $1', [request.params.id]);
    if (!result.rowCount) {
      response.status(404).json({ error: 'This prospect could not be found.' });
      return;
    }
    response.json({ prospect: prospect(result.rows[0]) });
  });

  router.post('/', protectWrite(origin), async (request, response) => {
    const parsed = prospectInput.safeParse(request.body);
    if (!parsed.success) return invalid(response, parsed.error);
    try {
      response.status(201).json({ prospect: await addProspect(pool, parsed.data) });
    } catch (error) { if (!duplicate(response, error)) throw error; }
  });

  router.put('/:id', protectWrite(origin), async (request, response) => {
    const parsed = updateInput.safeParse(request.body);
    if (!parsed.success) return invalid(response, parsed.error);
    try {
      const result = await pool.query<ProspectRow>(`
        UPDATE prospects SET name = $1, category = $2, website = $3, website_key = $4,
          name_key = $5, location_key = $6, contact_name = $7, email = $8, phone = $9,
          location = $10, relevance = $11, notes = $12, sources = $13::jsonb,
          version = version + 1, updated_at = NOW()
        WHERE id = $14 AND version = $15 RETURNING *
      `, [...values(parsed.data), request.params.id, parsed.data.version]);
      if (!result.rowCount) {
        const existing = await pool.query('SELECT id FROM prospects WHERE id = $1', [request.params.id]);
        response.status(existing.rowCount ? 409 : 404).json({ error: existing.rowCount
          ? 'This prospect was updated elsewhere. Reload it before saving your changes.'
          : 'This prospect could not be found.' });
        return;
      }
      response.json({ prospect: prospect(result.rows[0]) });
    } catch (error) { if (!duplicate(response, error)) throw error; }
  });
  return router;
}
