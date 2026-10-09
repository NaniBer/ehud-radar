import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, userInfo } from 'node:os';
import dotenv from 'dotenv';
import pg from 'pg';

const root = fileURLToPath(new URL('../', import.meta.url));
const bin = process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const data = join(root, 'data', 'postgres');
const envPath = join(root, '.env');
const control = join(bin, 'pg_ctl');
if (!existsSync(control)) throw new Error('Set PG_BIN to your PostgreSQL bin directory, or use Docker Compose / hosted PostgreSQL.');

if (process.argv.includes('--stop')) {
  execFileSync(control, ['-D', data, '-m', 'fast', 'stop'], { stdio: 'inherit' });
  process.exit(0);
}

if (!existsSync(envPath)) {
  const password = randomBytes(24).toString('hex');
  writeFileSync(envPath, [
    `POSTGRES_PASSWORD=${password}`,
    `DATABASE_URL=postgresql://ehud_radar:${password}@127.0.0.1:5433/ehud_radar`,
    'PORT=3002',
    'APP_ORIGIN=http://127.0.0.1:5174',
    'NODE_ENV=development',
    `SESSION_SECRET=${randomBytes(32).toString('hex')}`,
    `SETUP_TOKEN=${randomBytes(32).toString('hex')}`,
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
}
const env = dotenv.parse(readFileSync(envPath));
const url = new URL(env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '5433' || url.username !== 'ehud_radar'
  || url.pathname !== '/ehud_radar') {
  throw new Error('db:local expects the dedicated ehud_radar database at 127.0.0.1:5433. Existing configuration was preserved.');
}
mkdirSync(dirname(data), { recursive: true, mode: 0o700 });
if (!existsSync(join(data, 'PG_VERSION'))) {
  const temporary = mkdtempSync(join(tmpdir(), 'ehud-radar-init-'));
  const passwordFile = join(temporary, 'password');
  try {
    writeFileSync(passwordFile, `${decodeURIComponent(url.password)}\n`, { mode: 0o600 });
    execFileSync(join(bin, 'initdb'), [
      '-D', data, '--username=ehud_radar', '--auth-local=scram-sha-256',
      '--auth-host=scram-sha-256', `--pwfile=${passwordFile}`, '--encoding=UTF8', '--locale=C',
    ], { stdio: 'inherit' });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

try {
  execFileSync(control, ['-D', data, 'status'], { stdio: 'ignore' });
} catch {
  const sockets = join(tmpdir(), `ehud-radar-pg-${userInfo().uid}`);
  mkdirSync(sockets, { recursive: true, mode: 0o700 });
  execFileSync(control, [
    '-D', data, '-l', join(root, 'data', 'postgres.log'),
    '-o', `-h 127.0.0.1 -p 5433 -k '${sockets.replaceAll("'", "'\\''")}'`, '-w', 'start',
  ], { stdio: 'inherit' });
}

url.pathname = '/postgres';
const pool = new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
try {
  if (!(await pool.query("SELECT 1 FROM pg_database WHERE datname = 'ehud_radar'")).rowCount) {
    await pool.query('CREATE DATABASE ehud_radar');
  }
  console.log('Local PostgreSQL is ready. Credentials were saved only in the ignored .env file.');
} finally { await pool.end(); }
