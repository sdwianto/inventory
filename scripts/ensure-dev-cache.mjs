#!/usr/bin/env node
/**
 * Hindari cache Turbopack usang setelah migrasi route API ke TypeScript.
 * .next lama bisa masih mereferensikan app/api/[[...path]]/route.js yang sudah tidak ada.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const NEXT_DIR = '.next';
const STAMP_FILE = path.join(NEXT_DIR, '.dev-route-stamp');
const ROUTE_TS = 'app/api/[[...path]]/route.ts';

if (!fs.existsSync(ROUTE_TS)) {
  process.exit(0);
}

const hash = crypto.createHash('md5').update(fs.readFileSync(ROUTE_TS)).digest('hex');

function clearNext(reason) {
  console.log(`[dev] ${reason}`);
  fs.rmSync(NEXT_DIR, { recursive: true, force: true });
}

if (fs.existsSync(NEXT_DIR)) {
  const stampMissing = !fs.existsSync(STAMP_FILE);
  const stampStale = !stampMissing && fs.readFileSync(STAMP_FILE, 'utf8').trim() !== hash;

  if (stampMissing) {
    clearNext('Menghapus cache .next usang (API route sudah TypeScript)');
  } else if (stampStale) {
    clearNext('Menghapus cache .next (API route berubah)');
  }
}

fs.mkdirSync(NEXT_DIR, { recursive: true });
fs.writeFileSync(STAMP_FILE, hash);
