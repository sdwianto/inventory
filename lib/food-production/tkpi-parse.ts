/**
 * Parse TKPI CSV (delimiter `;`, desimal koma, titik ribuan).
 * Sumber TKPI: data/tkpi/TKPI.csv.
 * Acuan AKG aplikasi: Tabel 2 MBG satu kali makan (data/tkpi/akg-profiles.json),
 * bukan CSV AKG Sehari Permenkes. `parseAkgCsv` tetap ada untuk utilitas/legacy test.
 */

export interface TkpiFoodRow {
  kode: string;
  nama: string;
  airG?: number | null;
  energiKcal: number;
  proteinG: number;
  lemakG: number;
  karbohidratG: number;
  seratG?: number | null;
  abuG?: number | null;
  kalsiumMg?: number | null;
  fosforMg?: number | null;
  besiMg?: number | null;
  natriumMg?: number | null;
  kaliumMg?: number | null;
  tembagaMg?: number | null;
  sengMg?: number | null;
  retinolMcg?: number | null;
  betaKarotenMcg?: number | null;
  karotenTotalMcg?: number | null;
  thiaminMg?: number | null;
  riboflavinMg?: number | null;
  niasinMg?: number | null;
  vitaminCMg?: number | null;
  bddPct: number;
  mentahOlahan?: string;
  kelompok?: string;
  sumber?: string;
}

/** Parse Indonesian numeric cell: "1.244" → 1244, "11,3" → 11.3, "-" → null. */
export function parseIdNumber(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s || s === '-' || s === '—' || s === '–') return null;
  s = s.replace(/\u00a0/g, '').replace(/\s/g, '');
  // thousand dots + decimal comma: 1.244,5
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',') && !s.includes('.')) {
    s = s.replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function splitCsvLine(line: string): string[] {
  return line.split(';').map((c) => c.trim());
}

export function parseTkpiCsv(text: string): TkpiFoodRow[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  // 4 header rows; data starts at index 4
  const out: TkpiFoodRow[] = [];
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
      airG: parseIdNumber(cols[3]),
      energiKcal: energi ?? 0,
      proteinG: protein ?? 0,
      lemakG: lemak ?? 0,
      karbohidratG: karbo ?? 0,
      seratG: parseIdNumber(cols[8]),
      abuG: parseIdNumber(cols[9]),
      kalsiumMg: parseIdNumber(cols[10]),
      fosforMg: parseIdNumber(cols[11]),
      besiMg: parseIdNumber(cols[12]),
      natriumMg: parseIdNumber(cols[13]),
      kaliumMg: parseIdNumber(cols[14]),
      tembagaMg: parseIdNumber(cols[15]),
      sengMg: parseIdNumber(cols[16]),
      retinolMcg: parseIdNumber(cols[17]),
      betaKarotenMcg: parseIdNumber(cols[18]),
      karotenTotalMcg: parseIdNumber(cols[19]),
      thiaminMg: parseIdNumber(cols[20]),
      riboflavinMg: parseIdNumber(cols[21]),
      niasinMg: parseIdNumber(cols[22]),
      vitaminCMg: parseIdNumber(cols[23]),
      bddPct: bdd != null && bdd > 0 ? bdd : 100,
      mentahOlahan: cols[25] || undefined,
      kelompok: cols[26] || undefined,
      sumber: cols[27] || undefined,
    });
  }
  return out;
}

export interface AkgProfileSeed {
  key: string;
  label: string;
  energiKcal: number;
  proteinG: number;
  lemakG: number;
  karbohidratG: number;
  seratG: number;
  natriumMg: number;
  gulaG: number;
}

function ageKey(prefix: string, umur: string): string {
  const u = umur
    .toLowerCase()
    .replace(/\+/g, '_plus')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return `${prefix}_${u}`.toUpperCase();
}

/**
 * Extract macro AKG rows (Energi…Serat at cols 3–9) for Bayi/Anak, Laki-laki, Perempuan.
 * Natrium from mineral block (col 29 in full row) when present.
 */
export function parseAkgCsv(text: string): AkgProfileSeed[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const out: AkgProfileSeed[] = [];
  let section: 'ANAK' | 'LAKI' | 'PEREMPUAN' | null = null;

  for (const line of lines) {
    const cols = splitCsvLine(line);
    const c0 = (cols[0] || '').trim();
    if (/^Bayi\s*\/\s*Anak/i.test(c0)) {
      section = 'ANAK';
      continue;
    }
    if (/^Laki-laki$/i.test(c0)) {
      section = 'LAKI';
      continue;
    }
    if (/^Perempuan$/i.test(c0)) {
      section = 'PEREMPUAN';
      continue;
    }
    if (/^Hamil|^Menyusui|^Keterangan|^Istilah|^Tabel|^Angka|^Dengan|^Penggunaan|^Dalam|^AKG|^Sesuai/i.test(c0)) {
      section = null;
      continue;
    }
    if (!section) continue;
    if (!c0 || /^(Umur|Berat|;)/i.test(c0) || c0 === '') continue;
    // data rows start with age like "7 - 9 tahun"
    if (!/\d/.test(c0) || /minggu|bulan pertama|bulan kedua/i.test(c0)) {
      if (section === 'ANAK' && /\d/.test(c0)) {
        // allow "0 - 5 bulan", "7 - 9 tahun"
      } else if (section !== 'ANAK') {
        continue;
      }
    }
    if (!/bulan|tahun/i.test(c0)) continue;

    const energi = parseIdNumber(cols[3]);
    const protein = parseIdNumber(cols[4]);
    const lemak = parseIdNumber(cols[5]);
    const karbo = parseIdNumber(cols[8]);
    const serat = parseIdNumber(cols[9]);
    if (energi == null || protein == null) continue;
    // Mineral block: … Umur(26) Ca(27) P(28) Mg(29) Na(30) …
    const natrium = parseIdNumber(cols[30]);
    const key = ageKey(section, c0);
    const label =
      section === 'ANAK' ? `Anak ${c0}`
        : section === 'LAKI' ? `Laki-laki ${c0}`
          : `Perempuan ${c0}`;
    out.push({
      key,
      label,
      energiKcal: energi,
      proteinG: protein,
      lemakG: lemak ?? 0,
      karbohidratG: karbo ?? 0,
      seratG: serat ?? 0,
      natriumMg: natrium ?? 0,
      gulaG: 50,
    });
  }
  return out;
}

export function tkpiToNutritionFacts(row: TkpiFoodRow, gramsPerUnit = 100): {
  basis: 'PER_100G';
  gramsPerUnit: number;
  bddPct: number;
  energiKcal: number;
  proteinG: number;
  lemakG: number;
  karbohidratG: number;
  seratG: number;
  natriumMg: number;
  gulaG: number;
  tkpiCode: string;
  tkpiNama: string;
} {
  return {
    basis: 'PER_100G',
    gramsPerUnit,
    bddPct: row.bddPct,
    energiKcal: row.energiKcal,
    proteinG: row.proteinG,
    lemakG: row.lemakG,
    karbohidratG: row.karbohidratG,
    seratG: row.seratG ?? 0,
    natriumMg: row.natriumMg ?? 0,
    gulaG: 0,
    tkpiCode: row.kode,
    tkpiNama: row.nama,
  };
}

/** Guess grams per 1 stock unit from satuan label. */
export function guessGramsPerUnit(satuan?: string | null): number {
  const s = String(satuan || '').trim().toUpperCase();
  if (!s) return 100;
  if (s === 'KG' || s === 'KILOGRAM') return 1000;
  if (s === 'G' || s === 'GR' || s === 'GRAM') return 1;
  if (s === 'ONS') return 100;
  if (s === 'L' || s === 'LT' || s === 'LITER') return 1000;
  if (s === 'ML') return 1;
  return 100;
}
