import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { createAuth, requireAccount } from './modules/auth/auth.js';
import { createProspects } from './modules/prospects/prospects.js';
import { createDiscovery, type DiscoveryOptions } from './modules/discovery/discovery.js';
import { createOpenRouterAssessor, createSerperSearch, createTavilySearch, DiscoveryError } from './modules/discovery/providers.js';
import { createOutreach, type OutreachOptions } from './modules/outreach/outreach.js';
import { createOpenRouterDrafter } from './modules/outreach/provider.js';
import { FreeAiError } from './modules/ai/openrouter.js';

export function createApp(options: DiscoveryOptions & OutreachOptions & { tavilyApiKey?: string; serperApiKey?: string; searchEngine?: 'serper'|'tavily'; openRouterApiKey?: string; openRouterModel?: string }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  if (options.production) app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));

  // Liveness only; account routes report a database outage separately.
  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok', service: 'ehud-radar-api' });
  });

  app.use('/api', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  const auth = createAuth(options);
  app.use('/api', auth.sessionMiddleware);
  app.use('/api/auth', auth.router);
  app.use('/api/prospects', createProspects(options));
  app.use('/api/discovery', createDiscovery({ ...options,
    searchProvider: options.searchProvider ?? (options.searchEngine === 'tavily' ? createTavilySearch(options.tavilyApiKey) : createSerperSearch(options.serperApiKey)),
    searchEngine: options.searchEngine || 'serper',
    assessor: options.assessor ?? createOpenRouterAssessor(options.openRouterApiKey, options.openRouterModel),
  }));
  app.use('/api/outreach', createOutreach({ ...options, drafter: options.drafter ?? createOpenRouterDrafter(options.openRouterApiKey) }));
  app.get('/api/dashboard', requireAccount, (_request, response) => {
    response.json({ username: 'ehudaiuser', message: 'Your workspace is ready.' });
  });
  app.use('/api', (_request, response) => response.status(404).json({ error: 'This endpoint does not exist.' }));
  const onError: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof DiscoveryError || error instanceof FreeAiError) { response.status(error.status).json({ error: error.message }); return; }
    const status = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 503;
    response.status(status).json({ error: status === 503
      ? 'The service is unavailable. Try again shortly.' : 'Check the form and try again.' });
  };
  app.use(onError);
  return { app, store: auth.store };
}
