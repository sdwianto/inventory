/**
 * Build data/tkpi/tkpi-foods.json from TKPI.csv.
 * AKG profiles: jangan di-overwrite dari CSV — pakai Tabel 2 MBG
 * (data/tkpi/akg-profiles.json + akg-mbg-satu-kali.json).
 *
 * Usage: node scripts/build-tkpi-seed.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function parseIdNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s || s === '-' || s === '—' || s === '–') return null;
  s = s.replace(/\u00a0/g, '').replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function splitCsvLine(line) {
  return line.split(';').map((c) => c.trim());
}

function parseTkpiCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out = [];
  for (let i = 4; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const kode = (cols[1] || '').trim();
    const nama = (cols[2] || '').trim();
    if (!kode || !nama) continue;
    const energi = parseIdNumber(cols[4]);
    const protein = parseIdNumber(cols[5]);
    const lemak = parseIdNumber(cols[6]);
    const karbo = parseIdNumber(cols[7]);
    if (energi == null && protein == null && lemak == null && karbo == null) continue;
    const bdd = parseIdNumber(cols[24]);
    out.push({
      kode,
      nama,
      energiKcal: energi ?? 0,
      proteinG: protein ?? 0,
      lemakG: lemak ?? 0,
      karbohidratG: karbo ?? 0,
      seratG: parseIdNumber(cols[8]),
      natriumMg: parseIdNumber(cols[13]),
      bddPct: bdd != null && bdd > 0 ? bdd : 100,
      mentahOlahan: cols[25] || undefined,
      kelompok: cols[26] || undefined,
    });
  }
  return out;
}

const tkpiPath = resolve(root, 'data/tkpi/TKPI.csv');
const foods = parseTkpiCsv(readFileSync(tkpiPath, 'utf8'));
writeFileSync(
  resolve(root, 'data/tkpi/tkpi-foods.json'),
  JSON.stringify({ version: 1, source: 'TKPI 2019', count: foods.length, items: foods }, null, 0),
);

const akgPath = resolve(root, 'data/tkpi/akg-profiles.json');
const akgMeta = existsSync(akgPath)
  ? JSON.parse(readFileSync(akgPath, 'utf8'))
  : null;
const akgCount = Array.isArray(akgMeta?.profiles) ? akgMeta.profiles.length : 0;
console.log(
  `Wrote ${foods.length} TKPI foods. AKG unchanged (${akgCount} MBG meal profiles — not from AKG Sehari.csv).`,
);
