export const categories = [
  ['agency', 'Agency'], ['production_company', 'Production company'], ['filmmaker', 'Filmmaker'],
  ['creator', 'Creator'], ['brand', 'Brand'], ['education', 'Education'],
  ['community', 'Community'], ['other', 'Other'],
] as const;
export type Category = typeof categories[number][0];
export type Source = { title: string; url: string; note: string };
export type ProspectFields = {
  name: string; category: Category; website: string; contactName: string; email: string;
  phone: string; location: string; relevance: string; notes: string; sources: Source[];
};
export type Prospect = ProspectFields & { id: string; version: number; createdAt: string; updatedAt: string };
export type ProspectList = { prospects: Prospect[]; total: number; page: number; pageSize: number };

export class ProspectError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function prospectRequest<T>(path: string, options: {
  method?: 'GET' | 'POST' | 'PUT'; body?: object; csrfToken?: string; signal?: AbortSignal;
} = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/prospects${path}`, {
      method: options.method || 'GET', credentials: 'same-origin',
      headers: options.body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': options.csrfToken || '' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new ProspectError('Could not connect. Check your connection and try again.', 0);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ProspectError(data?.error || 'Could not complete the request. Try again.', response.status);
  return data as T;
}

export function categoryLabel(category: Category) { return categories.find(([value]) => value === category)?.[1] || category; }
export function safeHttpUrl(value: string) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
