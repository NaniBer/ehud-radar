import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';

const env = dotenv.parse(readFileSync(new URL('../.env', import.meta.url)));
if (env.NODE_ENV === 'production' || !/^[a-f0-9]{64}$/.test(env.SETUP_TOKEN || '')) {
  throw new Error('Local setup requires a development SETUP_TOKEN in .env.');
}
const origin = new URL(env.APP_ORIGIN || 'http://127.0.0.1:5174');
if (!['127.0.0.1', 'localhost'].includes(origin.hostname)) throw new Error('Setup links are for the local development app only.');
const link = `${origin.origin}/#setup=${env.SETUP_TOKEN}`;
console.log(process.argv.includes('--json') ? JSON.stringify({ url: link }) : link);
