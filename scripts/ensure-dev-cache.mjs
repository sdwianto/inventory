#!/usr/bin/env node
/**
 * Hindari cache Turbopack usang setelah migrasi route API ke TypeScript.
 * .next lama bisa masih mereferensikan app/api/[[...path]]/route.js yang sudah tidak ada.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const NEXT_DIR = '.next';
const CACHE_DIR = '.cache';
const STAMP_FILE = path.join(CACHE_DIR, 'dev-route-stamp');
const ROUTE_TS = 'app/api/[[...path]]/route.ts';

if (!fs.existsSync(ROUTE_TS)) {
  process.exit(0);
}

const hash = crypto.createHash('md5').update(fs.readFileSync(ROUTE_TS)).digest('hex');

function clearNext(reason) {
  console.log(`[dev] ${reason}`);
  fs.rmSync(NEXT_DIR, { recursive: true, force: true });
}

if (fs.existsSync(STAMP_FILE)) {
  const stampStale = fs.readFileSync(STAMP_FILE, 'utf8').trim() !== hash;
  if (stampStale) {
    clearNext('Menghapus cache .next (API route berubah)');
  }
} else if (fs.existsSync(NEXT_DIR)) {
  clearNext('Menghapus cache .next usang (belum ada stamp dev)');
}

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.writeFileSync(STAMP_FILE, hash);
