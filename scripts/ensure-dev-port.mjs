#!/usr/bin/env node
/**
 * Bebaskan port dev sebelum `npm run dev` — hindari EADDRINUSE berulang.
 * Hanya menghentikan proses next dev milik repo ini (cwd/cmdline cocok).
 */
import { execSync } from 'child_process';
import path from 'path';

const port = Number(process.env.APP_PORT || process.env.PORT || 3001);
const projectRoot = path.resolve(process.cwd());
const killOnly = process.argv.includes('--kill-only');

function sleepMs(ms) {
  try {
    execSync(`sleep ${Math.max(ms / 1000, 0.05)}`, { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

function getPidsOnPort(p) {
  try {
    const out = execSync(`fuser -n tcp ${p} 2>/dev/null`, { encoding: 'utf8' });
    return [...new Set(out.trim().split(/\s+/).filter(Boolean))].map(Number).filter((n) => n > 0);
  } catch {
    return [];
  }
}

function processCmd(pid) {
  try {
    return execSync(`tr '\\0' ' ' < /proc/${pid}/cmdline 2>/dev/null`, {
      encoding: 'utf8',
      shell: '/bin/bash',
    }).trim();
  } catch {
    return '';
  }
}

function processCwd(pid) {
  try {
    return execSync(`readlink -f /proc/${pid}/cwd 2>/dev/null`, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function isOurNextDev(pid) {
  const cmd = processCmd(pid);
  const cwd = processCwd(pid);
  if (!cmd.includes('next')) return false;
  if (cmd.includes(String(port)) || cmd.includes(`--port ${port}`)) {
    return cmd.includes(projectRoot) || cwd.startsWith(projectRoot);
  }
  if (cmd.includes('next-server') && cwd.startsWith(projectRoot)) return true;
  return cwd.startsWith(projectRoot) && (cmd.includes('next') || cmd.includes('node'));
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function portInUse(p) {
  return getPidsOnPort(p).length > 0;
}

const pids = getPidsOnPort(port);
if (!pids.length) {
  if (killOnly) console.log(`[dev] Port ${port} sudah bebas`);
  process.exit(0);
}

const ours = pids.filter(isOurNextDev);
const foreign = pids.filter((pid) => !ours.includes(pid));

if (foreign.length) {
  for (const pid of foreign) {
    console.error(`[dev] Port ${port} dipakai proses lain (pid ${pid}): ${processCmd(pid) || 'unknown'}`);
  }
  console.error(`[dev] Hentikan manual: fuser -k ${port}/tcp`);
  process.exit(1);
}

for (const pid of ours) {
  console.log(`[dev] Menghentikan next dev lama di port ${port} (pid ${pid})`);
  killPid(pid, 'SIGTERM');
}

for (let i = 0; i < 10 && portInUse(port); i += 1) {
  sleepMs(200);
}

const remaining = getPidsOnPort(port).filter(isOurNextDev);
for (const pid of remaining) {
  console.log(`[dev] Force kill pid ${pid}`);
  killPid(pid, 'SIGKILL');
}

sleepMs(300);

if (portInUse(port)) {
  console.error(`[dev] Port ${port} masih terpakai setelah cleanup`);
  process.exit(1);
}

if (killOnly) {
  console.log(`[dev] Port ${port} bebas`);
}
