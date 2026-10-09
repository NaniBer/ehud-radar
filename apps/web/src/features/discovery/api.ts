import { ProspectError, type Category } from '../prospects/api';
export type SearchRun = { id: string; category: Category; location: string; keywords: string; query: string;
  limit: number; provider: string; status: 'running'|'completed'|'failed'; error: string; createdAt: string;
  completedAt: string|null; candidateCount: number; savedCount: number };
export type Assessment = { name: string; relevance: string; confidence: 'high'|'medium'|'low'; evidenceQuotes: string[]; caveats: string[]; model: string };
export type Candidate = { id: string; runId: string; title: string; url: string; snippet: string; dismissed: boolean;
  savedProspectId: string|null; existingProspectId: string|null; assessment: Assessment|null;
  assessmentStatus: 'idle'|'running'|'completed'|'failed'; assessmentError: string };
export type RunDetail = { run: SearchRun; candidates: Candidate[] };
export type History = { runs: SearchRun[]; total: number; page: number; pageSize: number };
export type DiscoveryState = { searchReady: boolean; searchProvider: string|null; aiReady: boolean; aiModel: string|null;
  dailyLimit: number; searchesRemaining: number; assessmentsRemaining: number };
export async function discoveryRequest<T>(path: string, options: { body?: object; csrfToken?: string; signal?: AbortSignal } = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api/discovery${path}`, {
    method: options.body ? 'POST' : 'GET', credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': options.csrfToken || '' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
  }); } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ProspectError('The request could not finish. Check search history before starting another search.',0);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new ProspectError(result?.error || 'Discovery is unavailable. Try again shortly.',response.status);
  return result as T;
}
