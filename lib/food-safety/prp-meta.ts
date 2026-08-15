/**
 * Gelombang D — metadata PRP PRE-01…05 (BGN Bagian I–IV).
 * Bukan entity baru: field di food_safety_requirements + pengelompokan UI.
 */

export type PrpRequirementGroup = 'PRE-01' | 'PRE-02' | 'PRE-03' | 'PRE-04' | 'PRE-05';
export type PrpEvidenceType = 'CHECKLIST' | 'PHOTO' | 'MEASUREMENT' | 'DOCUMENT' | 'RECORD';

export const PRP_GROUP_ORDER: PrpRequirementGroup[] = [
  'PRE-01',
  'PRE-02',
  'PRE-03',
  'PRE-04',
  'PRE-05',
];

export const PRP_GROUP_LABELS: Record<PrpRequirementGroup, string> = {
  'PRE-01': 'Bangunan & lokasi',
  'PRE-02': 'Peralatan, air & utilitas',
  'PRE-03': 'Kebersihan, hama & bahan kimia',
  'PRE-04': 'Kebersihan orang',
  'PRE-05': 'Bahan, proses masak & sajian',
};

export const PRP_GROUP_BLURB: Record<PrpRequirementGroup, string> = {
  'PRE-01': 'Lokasi dapur aman dari banjir/kontaminan; ruang olah pangan tertutup dan terawat.',
  'PRE-02': 'Alat higienis, air layak, limbah terkelola, pendingin & alat ukur suhu.',
  'PRE-03': 'Pembersihan harian, pengendalian hama, bahan kimia tersimpan aman.',
  'PRE-04': 'Cuci tangan, APD, kesehatan pekerja, bukti pelatihan sederhana.',
  'PRE-05': 'Penerimaan, simpan, thawing, masak/saji, dan distribusi sesuai batas aman.',
};

export const PRP_EVIDENCE_TYPE_LABELS: Record<PrpEvidenceType, string> = {
  CHECKLIST: 'Checklist',
  PHOTO: 'Foto',
  MEASUREMENT: 'Pengukuran',
  DOCUMENT: 'Dokumen',
  RECORD: 'Rekaman',
};

/** Sumber resmi — file di repo, bukan kode internal BGN-PRP-*. */
export const BGN_HACCP_SOURCE = {
  label: 'Lampiran III — Checklist Sertifikasi HACCP BGN',
  path: 'docs/haccp/HACCP BGN.pdf',
  href: '/api/docs/haccp-bgn',
} as const;

export type PrpRequirementMeta = {
  requirementGroup: PrpRequirementGroup;
  bgnCode: string;
  evidenceType: PrpEvidenceType;
};

/** Metadata per kode requirement existing + celah kritis Gelombang D. */
export const PRP_REQUIREMENT_META: Record<string, PrpRequirementMeta> = {
  'SITE-01': { requirementGroup: 'PRE-01', bgnCode: 'BGN-1', evidenceType: 'CHECKLIST' },
  'SITE-02': { requirementGroup: 'PRE-01', bgnCode: 'BGN-3.1–3.7', evidenceType: 'PHOTO' },
  'CLN-01': { requirementGroup: 'PRE-01', bgnCode: 'BGN-3.1–3.7', evidenceType: 'CHECKLIST' },
  'CLN-02': { requirementGroup: 'PRE-03', bgnCode: 'BGN-5.x', evidenceType: 'CHECKLIST' },
  'EQP-01': { requirementGroup: 'PRE-02', bgnCode: 'BGN-4.x', evidenceType: 'CHECKLIST' },
  'WTR-01': { requirementGroup: 'PRE-02', bgnCode: 'BGN-3.12–3.14', evidenceType: 'CHECKLIST' },
  'WTR-02': { requirementGroup: 'PRE-02', bgnCode: 'BGN-3.12–3.14', evidenceType: 'MEASUREMENT' },
  'WST-01': { requirementGroup: 'PRE-02', bgnCode: 'BGN-4.x', evidenceType: 'CHECKLIST' },
  'PEST-01': { requirementGroup: 'PRE-03', bgnCode: 'BGN-5.x', evidenceType: 'CHECKLIST' },
  'PEST-02': { requirementGroup: 'PRE-03', bgnCode: 'BGN-5.x', evidenceType: 'CHECKLIST' },
  'PEST-03': { requirementGroup: 'PRE-03', bgnCode: 'BGN-5.x', evidenceType: 'CHECKLIST' },
  'HYG-01': { requirementGroup: 'PRE-04', bgnCode: 'BGN-6.x', evidenceType: 'CHECKLIST' },
  'HYG-02': { requirementGroup: 'PRE-04', bgnCode: 'BGN-6.x', evidenceType: 'CHECKLIST' },
  'HYG-03': { requirementGroup: 'PRE-04', bgnCode: 'BGN-6.x', evidenceType: 'DOCUMENT' },
  'RCV-01': { requirementGroup: 'PRE-05', bgnCode: 'BGN-7.1–7.4', evidenceType: 'CHECKLIST' },
  'RCV-02': { requirementGroup: 'PRE-05', bgnCode: 'BGN-7.1–7.4', evidenceType: 'RECORD' },
  'STOR-01': { requirementGroup: 'PRE-05', bgnCode: 'BGN-7.1–7.4', evidenceType: 'CHECKLIST' },
  'STOR-02': { requirementGroup: 'PRE-05', bgnCode: 'BGN-7.1–7.4', evidenceType: 'CHECKLIST' },
  'STOR-03': { requirementGroup: 'PRE-05', bgnCode: 'BGN-7.1–7.4', evidenceType: 'MEASUREMENT' },
  'PKG-01': { requirementGroup: 'PRE-05', bgnCode: 'BGN-7.11', evidenceType: 'CHECKLIST' },
  'PKG-02': { requirementGroup: 'PRE-05', bgnCode: 'BGN-7.11', evidenceType: 'RECORD' },
  'DIST-01': { requirementGroup: 'PRE-05', bgnCode: 'BGN-7.5–7.10', evidenceType: 'MEASUREMENT' },
  'DIST-02': { requirementGroup: 'PRE-05', bgnCode: 'BGN-7.5–7.10', evidenceType: 'RECORD' },
  'XCT-01': { requirementGroup: 'PRE-05', bgnCode: 'BGN-7.5–7.10', evidenceType: 'CHECKLIST' },
  'XCT-02': { requirementGroup: 'PRE-05', bgnCode: 'BGN-7.5–7.10', evidenceType: 'CHECKLIST' },
  'SERVE-01': { requirementGroup: 'PRE-05', bgnCode: 'BGN-7.5–7.10', evidenceType: 'MEASUREMENT' },
  'REHEAT-01': { requirementGroup: 'PRE-05', bgnCode: 'BGN-7.5–7.10', evidenceType: 'MEASUREMENT' },
};

export type ExtraPrpRequirementSeed = {
  programKode: string;
  kode: string;
  nama: string;
  description?: string;
};

/** Celah kritis saja — tetap engine QC, bukan modul baru. */
export const EXTRA_PRP_REQUIREMENT_SEEDS: ExtraPrpRequirementSeed[] = [
  {
    programKode: 'PRP-CLN',
    kode: 'SITE-01',
    nama: 'Lokasi dapur bebas banjir & kontaminan lingkungan',
    description: 'Cek genangan, sampah terbuka, dan sumber bau/asap di sekitar dapur.',
  },
  {
    programKode: 'PRP-CLN',
    kode: 'SITE-02',
    nama: 'Area olah pangan tertutup, lantai/dinding terawat',
    description: 'Tidak ada retak parah, langit-langit rontok, atau akses hewan liar.',
  },
  {
    programKode: 'PRP-WATER',
    kode: 'WTR-02',
    nama: 'Air proses/cuci tidak tercampur limbah; suhu/kejernihan dicatat',
    description: 'Air keruh atau berbau = jangan dipakai sampai diperbaiki.',
  },
  {
    programKode: 'PRP-PEST',
    kode: 'PEST-03',
    nama: 'Umpan/kimia hama terkunci, berlabel, jauh dari pangan',
    description: 'Tidak ada racun terbuka di area masak atau simpan bahan.',
  },
  {
    programKode: 'PRP-HYG',
    kode: 'HYG-03',
    nama: 'Bukti pelatihan higiene (foto/sertifikat singkat) tersedia',
    description: 'Bukan modul HR — cukup unggah bukti bahwa petugas sudah diingatkan SOP.',
  },
  {
    programKode: 'PRP-STOR',
    kode: 'STOR-03',
    nama: 'Thawing tidak di suhu ruang; cairan tetesan tidak mengenai pangan lain',
    description: 'Cairkan di chiller / air dingin mengalir sesuai SOP dapur.',
  },
  {
    programKode: 'PRP-DIST',
    kode: 'SERVE-01',
    nama: 'Sajian panas/dingin di titik layanan sesuai batas suhu',
    description: 'Hot holding / cold holding tercatat sebelum disajikan.',
  },
  {
    programKode: 'PRP-DIST',
    kode: 'REHEAT-01',
    nama: 'Pemanasan ulang mencapai suhu aman sebelum disaji',
    description: 'Jangan hanya menghangatkan permukaan — inti harus cukup panas.',
  },
];

export function resolvePrpMeta(kode: string): PrpRequirementMeta | null {
  return PRP_REQUIREMENT_META[String(kode || '').trim().toUpperCase()] || null;
}

/** Deep-link Setup accordion — persiapan Audit (Gelombang E). */
export function buildPrpSetupHref(opts?: {
  group?: string;
  requirementId?: string;
}): string {
  const p = new URLSearchParams();
  const g = String(opts?.group || '').toUpperCase();
  if (g.startsWith('PRE-')) p.set('group', g);
  if (opts?.requirementId) p.set('requirementId', opts.requirementId);
  const qs = p.toString();
  return qs ? `/kitchen-assurance/setup?${qs}` : '/kitchen-assurance/setup';
}

export function buildPrpRecordHref(opts: {
  programId: string;
  requirementId: string;
}): string {
  const p = new URLSearchParams();
  p.set('create', '1');
  p.set('category', 'PREREQUISITE');
  p.set('programId', opts.programId);
  p.set('requirementId', opts.requirementId);
  return `/food-production/qc?${p.toString()}`;
}

/** Satu baris per kode — cegah checklist dobel dari seed tenantId beda kapital. */
export function uniqueRequirementsByKode<T extends { kode?: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const kode = String(row.kode || '').trim().toUpperCase();
    if (kode.includes('__DUP__')) continue;
    if (kode) {
      if (seen.has(kode)) continue;
      seen.add(kode);
    }
    out.push(row);
  }
  return out;
}

export function groupRequirementsByPre<T extends { kode?: string; requirementGroup?: string }>(
  rows: T[],
): Record<PrpRequirementGroup, T[]> {
  const out = {
    'PRE-01': [] as T[],
    'PRE-02': [] as T[],
    'PRE-03': [] as T[],
    'PRE-04': [] as T[],
    'PRE-05': [] as T[],
  };
  for (const row of uniqueRequirementsByKode(rows)) {
    const fromField = String(row.requirementGroup || '').toUpperCase();
    const fromKode = resolvePrpMeta(String(row.kode || ''))?.requirementGroup;
    const g = (['PRE-01', 'PRE-02', 'PRE-03', 'PRE-04', 'PRE-05'] as const)
      .includes(fromField as PrpRequirementGroup)
      ? (fromField as PrpRequirementGroup)
      : fromKode;
    if (g) out[g].push(row);
  }
  return out;
}
