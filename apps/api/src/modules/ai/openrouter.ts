export class FreeAiError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

// Shared transport for explicit, bounded calls to free models only.
export async function requestFreeJson(apiKey: string, input: {
  name: string; schema: Record<string, unknown>; instructions: string; context: unknown; maxTokens: number;
}, fetcher: typeof fetch = fetch): Promise<{ content: unknown; model: string }> {
  let response: Response;
  try {
    response = await fetcher('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Ehud Radar' },
      body: JSON.stringify({ model: 'openrouter/free', max_tokens: input.maxTokens, stream: false,
        provider: { require_parameters: true, max_price: { prompt: 0, completion: 0 } },
        response_format: { type: 'json_schema', json_schema: { name: input.name, strict: true, schema: input.schema } },
        messages: [{ role: 'system', content: input.instructions }, { role: 'user', content: JSON.stringify(input.context) }],
      }),
    });
  } catch { throw new FreeAiError('AI could not connect. Try again later.'); }
  if (!response.ok) throw new FreeAiError(response.status === 429 ? 'The free model is rate limited. Try again later.'
    : response.status === 401 || response.status === 403 ? 'Check the backend OpenRouter API key.'
    : 'The free model is unavailable. You can still write and save a draft manually.');
  try {
    const payload = await response.json() as { model?: unknown; choices?: { message?: { content?: string } }[] };
    return { content: JSON.parse(payload.choices?.[0]?.message?.content || ''),
      model: typeof payload.model === 'string' ? payload.model.slice(0,200) : 'openrouter/free' };
  } catch { throw new FreeAiError('AI returned an unreadable response. Review the sources and try later.'); }
}
