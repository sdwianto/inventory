#!/usr/bin/env node
/**
 * ADR-004 Fase 3 — materialkan criticalLimit terstruktur dari criticalLimitNote.
 *
 * Default dry-run. Tambah --apply untuk menulis field criticalLimit pada
 * haccp_templates.items[] (criticalLimitNote tetap dipertahankan).
 *
 *   node scripts/migrate-haccp-critical-limits.mjs
 *   node scripts/migrate-haccp-critical-limits.mjs --tenant=t1 --apply
 */

import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function loadEnv() {
  try {
    for (const name of ['.env.local', '.env']) {
      const p = resolve(process.cwd(), name);
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m && !process.env[m[1].trim()]) {
          process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch { /* ignore */ }
}
loadEnv();

const COLLECTION = 'haccp_templates';
const apply = process.argv.includes('--apply');
const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
const tenantId = tenantArg ? tenantArg.slice('--tenant='.length) : undefined;

function parseNote(note, key, label) {
  const raw = String(note || '').trim();
  const between = raw.match(/^(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Z°%]+)?/);
  if (between) {
    return {
      key: `cl_${key}`,
      parameter: key,
      label: label || raw,
      operator: 'BETWEEN',
      value: Number(between[1].replace(',', '.')),
      valueMax: Number(between[2].replace(',', '.')),
      unit: between[3] ? between[3].replace('°', '') : undefined,
      note: raw,
    };
  }
  const opMatch = raw.match(/^(≥|>=|>|≤|<=|<|=)\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Z°%/]+)?/);
  if (opMatch) {
    const sym = opMatch[1];
    const operator =
      sym === '≥' || sym === '>=' ? 'GTE'
        : sym === '>' ? 'GT'
          : sym === '≤' || sym === '<=' ? 'LTE'
            : sym === '<' ? 'LT'
              : 'EQ';
    return {
      key: `cl_${key}`,
      parameter: key,
      label: label || raw,
      operator,
      value: Number(opMatch[2].replace(',', '.')),
      unit: opMatch[3] ? opMatch[3].replace('°', '') : undefined,
      note: raw,
    };
  }
  return {
    key: `cl_${key}`,
    parameter: key,
    label: label || raw || key,
    operator: 'TEXT',
    note: raw || undefined,
  };
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI wajib');
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const filter = tenantId ? { tenantId } : {};
  const cursor = db.collection(COLLECTION).find(filter);
  let scanned = 0;
  let wouldUpdate = 0;
  let updated = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    scanned += 1;
    const items = Array.isArray(doc.items) ? doc.items : [];
    let changed = false;
    const nextItems = items.map((item) => {
      if (item.criticalLimit && typeof item.criticalLimit === 'object') return item;
      const note = String(item.criticalLimitNote || '').trim();
      if (!note) return item;
      changed = true;
      return {
        ...item,
        criticalLimit: parseNote(note, item.key || 'item', item.label || note),
      };
    });
    if (!changed) continue;
    wouldUpdate += 1;
    console.log(
      `${apply ? 'APPLY' : 'DRY'} ${doc.tenantId} ${doc.kode || doc.id}: `
      + `${nextItems.filter((i) => i.criticalLimit).length} limit`,
    );
    if (apply) {
      await db.collection(COLLECTION).updateOne(
        { _id: doc._id },
        { $set: { items: nextItems, updatedAt: new Date() } },
      );
      updated += 1;
    }
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    tenantId: tenantId || null,
    scanned,
    wouldUpdate,
    updated,
  }, null, 2));
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
