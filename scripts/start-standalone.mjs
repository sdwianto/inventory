#!/usr/bin/env node
/**
 * Start Next.js standalone server (output: 'standalone' — next start is unsupported).
 * Copies public + .next/static into the standalone tree, then boots server.js.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const STANDALONE = join(ROOT, '.next/standalone');
const port = process.env.APP_PORT || process.env.PORT || '3001';
const host = process.env.APP_HOST || process.env.HOSTNAME || '127.0.0.1';

function findStandaloneServer() {
  const direct = join(STANDALONE, 'server.js');
  if (existsSync(direct)) return { server: direct, cwd: STANDALONE };
  if (!existsSync(STANDALONE)) return null;
  for (const entry of readdirSync(STANDALONE, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = join(STANDALONE, entry.name, 'server.js');
    if (existsSync(nested)) {
      return { server: nested, cwd: join(STANDALONE, entry.name) };
    }
  }
  return null;
}

const found = findStandaloneServer();
if (!found) {
  console.error('[start-standalone] missing .next/standalone/**/server.js — run npm run build first');
  process.exit(1);
}

mkdirSync(join(found.cwd, '.next'), { recursive: true });
if (existsSync(join(ROOT, 'public'))) {
  cpSync(join(ROOT, 'public'), join(found.cwd, 'public'), { recursive: true });
}
if (existsSync(join(ROOT, '.next/static'))) {
  cpSync(join(ROOT, '.next/static'), join(found.cwd, '.next/static'), { recursive: true });
}

const child = spawn(process.execPath, [found.server], {
  cwd: found.cwd,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(port),
    HOSTNAME: host,
  },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
