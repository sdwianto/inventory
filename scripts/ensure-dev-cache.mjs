#!/usr/bin/env node
/**
 * Hapus .next jika cache dev rusak/usang:
 * - proxy.js stale setelah migrasi middleware → proxy.ts
 * - routes.d.ts korup (crash/OOM saat compile) → route API/ERP 404 di dev
 * - hash app/api/[[...path]]/route.ts berubah
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const NEXT_DIR = '.next';
const CACHE_DIR = '.cache';
const STAMP_FILE = path.join(CACHE_DIR, 'dev-route-stamp');
const ROUTE_TS = 'app/api/[[...path]]/route.ts';

function clearNext(reason) {
  console.warn(`[dev] Cache .next usang (${reason}) — membersihkan sebelum start...`);
  rmSync(NEXT_DIR, { recursive: true, force: true });
}

let stale = false;

const routesTypesPath = '.next/dev/types/routes.d.ts';
if (existsSync(routesTypesPath)) {
  try {
    const src = readFileSync(routesTypesPath, 'utf8');
    if (/^\/[a-z][^"\n]*": \{\}/m.test(src)) stale = true;
    if (!stale && src.includes('PageRoutes = never') && src.includes('"/dashboard"')) stale = true;
    if (!stale && !src.includes('/api/[[...path]]')) stale = true;
  } catch {
    /* ignore */
  }
}

if (!stale) {
  const hasProxyTs = existsSync('proxy.ts');
  const hasProxyJs = existsSync('proxy.js');
  const middlewarePath = '.next/dev/server/middleware.js';

  if (hasProxyTs && !hasProxyJs && existsSync(middlewarePath)) {
    try {
      const src = readFileSync(middlewarePath, 'utf8');
      if (src.includes('proxy.js')) stale = true;
    } catch {
      /* ignore */
    }
  }
}

if (!stale && existsSync(ROUTE_TS)) {
  const hash = createHash('md5').update(readFileSync(ROUTE_TS)).digest('hex');
  if (existsSync(STAMP_FILE)) {
    if (readFileSync(STAMP_FILE, 'utf8').trim() !== hash) stale = true;
  } else if (existsSync(NEXT_DIR)) {
    stale = true;
  }
  if (!stale) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(STAMP_FILE, hash);
    process.exit(0);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(STAMP_FILE, hash);
}

if (stale) {
  clearNext('typed routes / proxy / API route');
}
