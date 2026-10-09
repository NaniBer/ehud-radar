export type AuthState = {
  authenticated: boolean;
  username: string;
  setupRequired: boolean;
  csrfToken: string;
  demoPassword?: string;
};

export async function request<T>(path: string, body?: object, csrfToken?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken || '' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error('Could not connect. Check that the server is running, then try again.'); }
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || 'Something went wrong. Try again.');
  return data as T;
}
