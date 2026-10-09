import { createApp } from './app.js';
import { readConfig } from './config.js';
import { openDatabase, migrateDatabase } from './db/database.js';

try {
  const config = readConfig();
  const pool = openDatabase(config.databaseUrl);
  pool.on('error', () => console.error('The database connection was interrupted.'));
  await migrateDatabase(pool);
  const { app, store } = createApp({ ...config, pool });
  const server = app.listen(config.port, config.host, () => {
    console.log(`Ehud Radar API listening at http://${config.host}:${config.port}`);
  });
  server.on('error', () => {
    console.error('Could not start the API. Check whether its port is in use.');
    store.close();
    void pool.end().finally(() => process.exit(1));
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close(() => {
        store.close();
        void pool.end();
      });
    });
  }
} catch (error) {
  if (error instanceof Error && error.message.startsWith('Check .env')) {
    console.error(error.message);
  } else {
    console.error('Could not initialize the API.', error instanceof Error ? error.stack : error);
  }
  process.exit(1);
}
