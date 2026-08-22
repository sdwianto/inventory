#!/usr/bin/env node
/**
 * Gap-fill USDA SR Legacy untuk master produk yang tidak ketemu di TKPI.
 *
 *   npx tsx scripts/fill-usda-gaps-from-master.ts --from-xlsx=docs/akg/Review-Mapping-Produk-TKPI.xlsx
 *   npx tsx scripts/fill-usda-gaps-from-master.ts --from-xlsx=... --andrafarm
 *
 * Alur: TKPI tidak_ketemu → USDA SR resmi (.cache) → bila kosong, Andrafarm daftar-usda
 * (hanya seed; ERP tidak scrape Andrafarm saat runtime). Analog buruk tidak diimpor ke katalog.
 */

import { createReadStream, mkdirSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import { dirname, resolve } from 'path';
import * as XLSX from 'xlsx';
import usdaFoodsJson from '../data/usda/usda-foods.json';

type CatalogItem = {
  kode: string;
  ndb?: string;
  fdcId?: number;
  nama: string;
  namaId?: string;
  aliases?: string[];
  kelompok?: string;
  energiKcal: number;
  proteinG: number;
  lemakG: number;
  karbohidratG: number;
  seratG?: number;
  natriumMg?: number;
  bddPct: number;
};

type GapSpec = {
  id: string;
  test: RegExp;
  ndb: string;
  namaId: string;
  aliases: string[];
  kelompok: string;
  via: 'usda_sr' | 'andrafarm_sr';
};

type ReviewRow = {
  kode: string;
  nama: string;
  satuan: string;
  grup: string;
  itemRole: string;
  jenis: 'pangan' | 'bukan_pangan';
  status: string;
  usdaKode: string;
  usdaNama: string;
  usdaNamaId: string;
  kkal: number | '';
  sumber: string;
  catatan: string;
};

const args = process.argv.slice(2);
const xlsxArg = args.find((a) => a.startsWith('--from-xlsx='));
const outArg = args.find((a) => a.startsWith('--out='));
const catalogArg = args.find((a) => a.startsWith('--catalog='));
const useAndrafarm = args.includes('--andrafarm');
const dryRun = args.includes('--dry-run');

const xlsxPath = resolve(
  process.cwd(),
  xlsxArg ? xlsxArg.slice('--from-xlsx='.length) : 'docs/akg/Review-Mapping-Produk-TKPI.xlsx',
);
const outPath = resolve(
  process.cwd(),
  outArg ? outArg.slice('--out='.length) : 'docs/akg/Review-Gap-USDA.xlsx',
);
const catalogPath = resolve(
  process.cwd(),
  catalogArg ? catalogArg.slice('--catalog='.length) : 'data/usda/usda-foods.json',
);
const srDir = resolve(process.cwd(), '.cache/usda/FoodData_Central_sr_legacy_food_csv_2018-04');

const NON_FOOD = /masker|kresek|kreserk|plastik|sarung\s*tangan|tisu|lpg\b|wipol|vixal|sunlight|wrapping|kertas|folio|hvs\b|thin\s*wall|alumunium|aluminium|foil|kantong\s*sampah|hair\s*net|sabut|joyoboyo|petromax|klip|opp\b|carton|toiletries/i;

/** Padanan gap master → NDB SR. Oyster sauce 06176 ditemukan lewat Andrafarm, dikonfirmasi di SR. */
const GAP_SPECS: GapSpec[] = [
  { id: 'longan', test: /klengkeng|kelengkeng|longan/i, ndb: '09172', namaId: 'Kelengkeng, segar', aliases: ['kelengkeng', 'klengkeng', 'longan', 'longans'], kelompok: 'Buah', via: 'usda_sr' },
  { id: 'strawberry', test: /strawber|stroberi|strawberi/i, ndb: '09316', namaId: 'Stroberi, segar', aliases: ['stroberi', 'strawberi', 'strawbery', 'strawberry', 'strawberries'], kelompok: 'Buah', via: 'usda_sr' },
  { id: 'mayo', test: /mayo/i, ndb: '04025', namaId: 'Mayones', aliases: ['mayones', 'mayonnaise', 'mayo', 'mayonese', 'mayonnese'], kelompok: 'Lemak', via: 'usda_sr' },
  { id: 'edamame', test: /\bedamame\b/i, ndb: '11450', namaId: 'Edamame, segar', aliases: ['edamame'], kelompok: 'Kacang', via: 'usda_sr' },
  { id: 'cauliflower', test: /brokoli\s*putih|brungkul|kembang\s*kol|cauliflower/i, ndb: '11135', namaId: 'Kembang kol / brokoli putih, segar', aliases: ['brokoli putih', 'brungkul', 'kembang kol', 'cauliflower'], kelompok: 'Sayur', via: 'usda_sr' },
  { id: 'pear', test: /\bpear\b|\bpir\b/i, ndb: '09252', namaId: 'Pir, segar', aliases: ['pear', 'pir', 'pears'], kelompok: 'Buah', via: 'usda_sr' },
  { id: 'pasta', test: /macaroni|penne|pasta/i, ndb: '20120', namaId: 'Pasta kering (macaroni)', aliases: ['macaroni', 'penne', 'pasta kering', 'pasta'], kelompok: 'Serealia', via: 'usda_sr' },
  { id: 'cheddar', test: /cheddar|ceddar|chesese|keju/i, ndb: '01009', namaId: 'Keju cheddar', aliases: ['cheddar', 'ceddar', 'keju cheddar', 'keju kraft'], kelompok: 'Susu', via: 'usda_sr' },
  { id: 'processed-cheese', test: /prochiz/i, ndb: '01042', namaId: 'Keju olahan slice', aliases: ['prochiz', 'keju slice', 'processed cheese'], kelompok: 'Susu', via: 'usda_sr' },
  { id: 'salt', test: /\bgaram\b/i, ndb: '02047', namaId: 'Garam meja', aliases: ['garam', 'garam kapal', 'table salt'], kelompok: 'Bumbu', via: 'usda_sr' },
  { id: 'cardamom', test: /kapulaga|cardamom/i, ndb: '02006', namaId: 'Kapulaga', aliases: ['kapulaga', 'cardamom'], kelompok: 'Bumbu', via: 'usda_sr' },
  { id: 'cinnamon', test: /kayu\s*manis|cinnamon|cassia/i, ndb: '02010', namaId: 'Kayu manis (rempah), bubuk', aliases: ['kayu manis', 'kayumanis', 'cinnamon', 'cassia', 'rempah kayu manis'], kelompok: 'Bumbu', via: 'usda_sr' },
  { id: 'lemongrass', test: /serai|lemongrass|lemon\s*grass/i, ndb: '11972', namaId: 'Serai, segar', aliases: ['serai', 'batang serai', 'lemongrass'], kelompok: 'Bumbu', via: 'usda_sr' },
  { id: 'coriander', test: /ketumbar|coriander/i, ndb: '02013', namaId: 'Ketumbar biji', aliases: ['ketumbar', 'coriander'], kelompok: 'Bumbu', via: 'usda_sr' },
  { id: 'turmeric', test: /kunyit|turmeric/i, ndb: '02043', namaId: 'Kunyit bubuk', aliases: ['kunyit', 'turmeric'], kelompok: 'Bumbu', via: 'usda_sr' },
  { id: 'cumin', test: /jinten|jintan|cumin/i, ndb: '02014', namaId: 'Jinten / jintan', aliases: ['jinten', 'jintan', 'cumin'], kelompok: 'Bumbu', via: 'usda_sr' },
  { id: 'nutmeg', test: /\bpala\b|nutmeg/i, ndb: '02025', namaId: 'Pala bubuk', aliases: ['pala', 'nutmeg'], kelompok: 'Bumbu', via: 'usda_sr' },
  { id: 'pepper', test: /merica|lada\s*hitam|ladaku/i, ndb: '02030', namaId: 'Merica hitam', aliases: ['merica', 'lada hitam', 'ladaku', 'black pepper'], kelompok: 'Bumbu', via: 'usda_sr' },
  { id: 'chili', test: /cabe\s*merah|cabai\s*merah/i, ndb: '11819', namaId: 'Cabai merah besar, segar', aliases: ['cabe merah', 'cabai merah', 'cabe merah besar'], kelompok: 'Sayur', via: 'usda_sr' },
  { id: 'bokchoy', test: /pokcoy|pakcoy|bok\s*choy|pak[\s-]?choi/i, ndb: '11116', namaId: 'Pakcoy / pokcoy, segar', aliases: ['pokcoy', 'pakcoy', 'bok choy', 'pak choi'], kelompok: 'Sayur', via: 'usda_sr' },
  { id: 'milk', test: /full\s*cream|susu\s*full/i, ndb: '01077', namaId: 'Susu full cream', aliases: ['full cream', 'ultra full cream', 'susu full cream'], kelompok: 'Susu', via: 'usda_sr' },
  { id: 'baking-soda', test: /backing\s*soda|baking\s*soda|soda\s*kue/i, ndb: '18372', namaId: 'Soda kue / baking soda', aliases: ['baking soda', 'backing soda', 'soda kue'], kelompok: 'Bumbu', via: 'usda_sr' },
  { id: 'ketchup', test: /saos\s*tomat|saus\s*tomat|ketchup|catsup/i, ndb: '11935', namaId: 'Saus tomat', aliases: ['saus tomat', 'saos tomat', 'ketchup', 'catsup'], kelompok: 'Bumbu', via: 'usda_sr' },
  { id: 'chili-sauce', test: /saus\s*sambal|saos\s*sambal/i, ndb: '06972', namaId: 'Saus sambal (chili sauce)', aliases: ['saus sambal', 'saos sambal', 'chili sauce'], kelompok: 'Bumbu', via: 'usda_sr' },
  { id: 'bolognese', test: /bolognese|marinara/i, ndb: '06931', namaId: 'Saus pasta / bolognese', aliases: ['bolognese', 'saus pasta', 'marinara'], kelompok: 'Bumbu', via: 'usda_sr' },
  { id: 'chicken-bouillon', test: /kno+r\s*ayam|kaldu\s*ayam/i, ndb: '06080', namaId: 'Kaldu ayam bubuk', aliases: ['knorr ayam', 'knoor ayam', 'kaldu ayam'], kelompok: 'Bumbu', via: 'usda_sr' },
  { id: 'beef-bouillon', test: /kno+r\s*rostip|masako/i, ndb: '06075', namaId: 'Kaldu sapi bubuk', aliases: ['knorr rostip', 'knoor rostip', 'masako', 'kaldu sapi'], kelompok: 'Bumbu', via: 'usda_sr' },
  { id: 'oyster-sauce', test: /saus\s*tiram|saos\s*tiram|oyster\s*sauce/i, ndb: '06176', namaId: 'Saus tiram', aliases: ['saus tiram', 'saos tiram', 'oyster sauce'], kelompok: 'Bumbu', via: 'andrafarm_sr' },
  { id: 'creamer', test: /fiber\s*cream|krimer|creamer/i, ndb: '01069', namaId: 'Krimer bubuk', aliases: ['fiber cream', 'krimer', 'creamer'], kelompok: 'Susu', via: 'usda_sr' },
  { id: 'whipped', test: /whip+e?d\s*cream|whipped/i, ndb: '01054', namaId: 'Whipped cream', aliases: ['whipped cream', 'whiped cream', 'whip cream'], kelompok: 'Susu', via: 'usda_sr' },
  { id: 'meatball', test: /\bbakso\b|\bbaso\b|\bpentol\b|meatball/i, ndb: '07972', namaId: 'Bakso, beku, gaya Italia', aliases: ['bakso', 'baso', 'pentol', 'bakso beku', 'meatball', 'meatballs'], kelompok: 'Daging', via: 'usda_sr' },
];

const NUTRIENT_IDS: Record<string, keyof Pick<CatalogItem, 'energiKcal' | 'proteinG' | 'lemakG' | 'karbohidratG' | 'seratG' | 'natriumMg'>> = {
  '1008': 'energiKcal',
  '1003': 'proteinG',
  '1004': 'lemakG',
  '1005': 'karbohidratG',
  '1079': 'seratG',
  '1093': 'natriumMg',
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (c === ',' && !quoted) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function padNdb(ndb: string): string {
  return String(ndb || '').replace(/\D/g, '').padStart(5, '0');
}

function roundNut(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (Math.abs(n - Math.round(n)) < 1e-9) return Math.round(n);
  return Math.round(n * 100) / 100;
}

async function loadSrIndex() {
  const foodPath = resolve(srDir, 'food.csv');
  const srPath = resolve(srDir, 'sr_legacy_food.csv');
  const nutPath = resolve(srDir, 'food_nutrient.csv');
  const ndbToFdc = new Map<string, string>();
  const fdcToNdb = new Map<string, string>();
  const fdcToNama = new Map<string, string>();

  for await (const line of createInterface({ input: createReadStream(srPath, 'utf8') })) {
    if (line.startsWith('"fdc_id"')) continue;
    const [fdc, ndb] = parseCsvLine(line);
    if (!fdc || !ndb) continue;
    const padded = padNdb(ndb);
    ndbToFdc.set(padded, fdc);
    ndbToFdc.set(ndb, fdc);
    fdcToNdb.set(fdc, padded);
  }
  for await (const line of createInterface({ input: createReadStream(foodPath, 'utf8') })) {
    if (line.startsWith('"fdc_id"')) continue;
    const [fdc, , desc] = parseCsvLine(line);
    if (fdc && desc) fdcToNama.set(fdc, desc);
  }

  const neededFdc = new Set<string>();
  for (const spec of GAP_SPECS) {
    const fdc = ndbToFdc.get(padNdb(spec.ndb));
    if (fdc) neededFdc.add(fdc);
  }

  const nuts = new Map<string, Partial<CatalogItem>>();
  for await (const line of createInterface({ input: createReadStream(nutPath, 'utf8') })) {
    if (line.startsWith('"id"')) continue;
    const cols = parseCsvLine(line);
    const fdc = cols[1];
    const nid = cols[2];
    if (!neededFdc.has(fdc)) continue;
    const field = NUTRIENT_IDS[nid];
    if (!field) continue;
    const amount = Number(cols[3] || 0);
    const row = nuts.get(fdc) || {};
    row[field] = roundNut(amount);
    nuts.set(fdc, row);
  }

  return { ndbToFdc, fdcToNdb, fdcToNama, nuts };
}

function mergeAliases(a: string[] | undefined, b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...(a || []), ...b]) {
    const k = x.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x.trim());
  }
  return out;
}

function specToItem(
  spec: GapSpec,
  sr: Awaited<ReturnType<typeof loadSrIndex>>,
): CatalogItem | null {
  const ndb = padNdb(spec.ndb);
  const fdc = sr.ndbToFdc.get(ndb);
  if (!fdc) return null;
  const nut = sr.nuts.get(fdc) || {};
  const nama = sr.fdcToNama.get(fdc) || spec.namaId;
  return {
    kode: `USDA-${ndb}`,
    ndb,
    fdcId: Number(fdc),
    nama,
    namaId: spec.namaId,
    aliases: spec.aliases,
    kelompok: spec.kelompok,
    energiKcal: Number(nut.energiKcal || 0),
    proteinG: Number(nut.proteinG || 0),
    lemakG: Number(nut.lemakG || 0),
    karbohidratG: Number(nut.karbohidratG || 0),
    seratG: Number(nut.seratG || 0),
    natriumMg: Number(nut.natriumMg || 0),
    bddPct: 100,
  };
}

function matchSpec(nama: string): GapSpec | null {
  return GAP_SPECS.find((s) => s.test.test(nama)) || null;
}

function loadGapProducts(): Array<{ kode: string; nama: string; satuan: string; grup: string; itemRole: string }> {
  const wb = XLSX.readFile(xlsxPath);
  const sheet = wb.Sheets.Tidak_ketemu;
  if (!sheet) throw new Error(`Sheet Tidak_ketemu tidak ada di ${xlsxPath}`);
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '' });
  const seen = new Set<string>();
  const out: Array<{ kode: string; nama: string; satuan: string; grup: string; itemRole: string }> = [];
  for (const r of rows) {
    const kode = String(r.kode || '').trim();
    const nama = String(r.nama || '').trim();
    const key = `${kode}|${nama}`;
    if (!kode || !nama || seen.has(key)) continue;
    seen.add(key);
    out.push({
      kode,
      nama,
      satuan: String(r.satuan || ''),
      grup: String(r.grup || ''),
      itemRole: String(r.itemRole || ''),
    });
  }
  return out;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function searchAndrafarm(query: string): Promise<{ ndb: string; namaId: string; title: string } | null> {
  const url = new URL('https://www.andrafarm.com/_andra.php');
  url.searchParams.set('_i', 'daftar-usda');
  url.searchParams.set('milih', query);
  url.searchParams.set('darifilecari', 'IYA');
  url.searchParams.set('urut', '1');
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      accept: 'text/html',
    },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const title = (html.match(/<TITLE>(.*?)<\/TITLE>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&\w+;/g, ' ').replace(/\s+/g, ' ');
  const m = text.match(/(\d{1,3})\s+(\d{4,5})\s+(.{5,80}?)\s+([\d,.-]+)\s+([\d,.-]+)/);
  if (!m) return { ndb: '', namaId: '', title };
  return { ndb: padNdb(m[2]), namaId: m[3].replace(/\s+/g, ' ').trim(), title };
}

function andrafarmQuery(nama: string): string {
  return nama
    .replace(/\d+([.,]\d+)?\s*(ml|g|gr|kg|l|ltr|ons|pcs)?/gi, ' ')
    .replace(/['"].*$/g, ' ')
    .replace(/\b(desaku|maestro|delmonte|saori|totole|ajinomoto|ultra|kraft|kraf|al\s*barokah)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

async function main() {
  const products = loadGapProducts();
  const sr = await loadSrIndex();
  const byNdb = new Map<string, CatalogItem>();
  for (const spec of GAP_SPECS) {
    const item = specToItem(spec, sr);
    if (!item) {
      console.warn(`NDB ${spec.ndb} (${spec.id}) tidak ada di cache SR`);
      continue;
    }
    const prev = byNdb.get(item.ndb!);
    if (prev) {
      prev.aliases = mergeAliases(prev.aliases, spec.aliases);
      if (!prev.namaId) prev.namaId = spec.namaId;
    } else {
      byNdb.set(item.ndb!, item);
    }
  }

  const existing = (usdaFoodsJson.items || []) as CatalogItem[];
  const merged: CatalogItem[] = existing.map((row) => ({ ...row, aliases: [...(row.aliases || [])] }));
  const byKode = new Map(merged.map((r) => [r.kode, r]));

  for (const item of byNdb.values()) {
    const cur = byKode.get(item.kode);
    if (cur) {
      cur.aliases = mergeAliases(cur.aliases, item.aliases || []);
      if (item.namaId) cur.namaId = item.namaId;
    } else {
      merged.push(item);
      byKode.set(item.kode, item);
    }
  }

  const review: ReviewRow[] = [];
  const andrafarmCache = new Map<string, Awaited<ReturnType<typeof searchAndrafarm>>>();

  for (const p of products) {
    const bukanPangan = NON_FOOD.test(p.nama) || p.itemRole === 'PACKAGING' || p.itemRole === 'CONSUMABLE';
    if (bukanPangan) {
      review.push({
        kode: p.kode, nama: p.nama, satuan: p.satuan, grup: p.grup, itemRole: p.itemRole,
        jenis: 'bukan_pangan', status: 'dilewati', usdaKode: '', usdaNama: '', usdaNamaId: '',
        kkal: '', sumber: '', catatan: 'Bukan bahan pangan — tidak dicari di USDA/Andrafarm',
      });
      continue;
    }

    const spec = matchSpec(p.nama);
    if (spec) {
      const item = byKode.get(`USDA-${padNdb(spec.ndb)}`);
      review.push({
        kode: p.kode, nama: p.nama, satuan: p.satuan, grup: p.grup, itemRole: p.itemRole,
        jenis: 'pangan', status: 'diimpor',
        usdaKode: item?.kode || `USDA-${padNdb(spec.ndb)}`,
        usdaNama: item?.nama || '',
        usdaNamaId: item?.namaId || spec.namaId,
        kkal: item?.energiKcal ?? '',
        sumber: spec.via === 'andrafarm_sr' ? 'Andrafarm → USDA SR' : 'USDA SR Legacy',
        catatan: spec.via === 'andrafarm_sr'
          ? 'Nama Indonesia tidak ketemu di pencarian SR; Andrafarm mengarah ke NDB yang ada di SR'
          : 'Cocok USDA SR Legacy (nilai gizi dari CSV resmi, bukan scrape)',
      });
      continue;
    }

    let catatan = 'Tidak ada padanan SR yang aman (bukan analog bermerek/kalengan yang jauh)';
    let status = 'tidak_ada';
    let usdaKode = '';
    let usdaNama = '';
    let usdaNamaId = '';
    let kkal: number | '' = '';
    let sumber = '';

    if (useAndrafarm) {
      const q = andrafarmQuery(p.nama);
      if (q.length >= 3) {
        if (!andrafarmCache.has(q)) {
          andrafarmCache.set(q, await searchAndrafarm(q));
          await sleep(400);
        }
        const hit = andrafarmCache.get(q);
        if (hit?.ndb && sr.ndbToFdc.has(hit.ndb)) {
          const fdc = sr.ndbToFdc.get(hit.ndb)!;
          status = 'andrafarm_analog';
          usdaKode = `USDA-${hit.ndb}`;
          usdaNama = sr.fdcToNama.get(fdc) || '';
          usdaNamaId = hit.namaId;
          kkal = Number(sr.nuts.get(fdc)?.energiKcal || 0) || '';
          sumber = 'Andrafarm daftar-usda';
          catatan = `Andrafarm NDB ${hit.ndb} (${usdaNama}) — analog, tidak diimpor ke katalog cadangan`;
        } else if (hit?.title) {
          sumber = 'Andrafarm daftar-usda';
          catatan = `Andrafarm halaman "${hit.title}" tanpa baris NDB USDA`;
        }
      }
    }

    review.push({
      kode: p.kode, nama: p.nama, satuan: p.satuan, grup: p.grup, itemRole: p.itemRole,
      jenis: 'pangan', status, usdaKode, usdaNama, usdaNamaId, kkal, sumber, catatan,
    });
  }

  const catalog = {
    source: 'USDA SR Legacy (FoodData Central)',
    note: 'Cadangan sebagian (gap-fill) bila bahan tidak ada di TKPI 2019 — bukan seluruh ~8790 baris USDA/Andrafarm. Nilai per 100 g edible portion (BDD 100%). Sumber resmi USDA SR; Andrafarm hanya untuk menemukan NDB yang sudah ada di SR.',
    items: merged,
  };

  const pangan = review.filter((r) => r.jenis === 'pangan');
  const imported = review.filter((r) => r.status === 'diimpor');
  const skipped = review.filter((r) => r.jenis === 'bukan_pangan');
  const missing = review.filter((r) => r.jenis === 'pangan' && r.status !== 'diimpor');

  if (!dryRun) {
    writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    mkdirSync(dirname(outPath), { recursive: true });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(review), 'Semua_gap');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(imported), 'Diimpor_USDA');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(missing), 'Pangan_tanpa_padanan');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(skipped), 'Bukan_pangan');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
      { metrik: 'sumberTkpiGap', nilai: xlsxPath },
      { metrik: 'sumberUsda', nilai: 'USDA SR Legacy CSV 2018-04 (FoodData Central)' },
      { metrik: 'andrafarm', nilai: useAndrafarm ? 'https://www.andrafarm.com/_andra.php?_i=daftar-usda' : 'tidak dijalankan' },
      { metrik: 'totalGap', nilai: review.length },
      { metrik: 'pangan', nilai: pangan.length },
      { metrik: 'diimporKatalog', nilai: imported.length },
      { metrik: 'panganTanpaPadanan', nilai: missing.length },
      { metrik: 'bukanPangan', nilai: skipped.length },
      { metrik: 'katalogUsdaBaris', nilai: merged.length },
      { metrik: 'generatedAt', nilai: new Date().toISOString() },
    ]), 'Petunjuk');
    writeFileSync(outPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
  }

  console.log(JSON.stringify({
    xlsx: xlsxPath,
    out: dryRun ? '(dry-run)' : outPath,
    catalog: dryRun ? '(dry-run)' : catalogPath,
    catalogItems: merged.length,
    totalGap: review.length,
    pangan: pangan.length,
    diimpor: imported.length,
    panganTanpaPadanan: missing.length,
    bukanPangan: skipped.length,
    andrafarm: useAndrafarm,
    missingNames: missing.map((m) => m.nama),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
