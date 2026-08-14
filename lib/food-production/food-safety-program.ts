/**
 * Food Safety Prerequisite — ADR-004 Fase 2.
 * Master Program + Requirement (ringan). Checklist tetap di engine QC.
 * Seed 11 program selaras PRP/BGN umum; label contoh, bukan acuan hukum.
 */

export const FOOD_SAFETY_PROGRAMS_COLLECTION = 'food_safety_programs';
export const FOOD_SAFETY_REQUIREMENTS_COLLECTION = 'food_safety_requirements';

export type FoodSafetyProgramSource = 'BGN' | 'INTERNAL';
export type FoodSafetyProgramFrequency =
  | 'PER_SHIFT'
  | 'DAILY'
  | 'WEEKLY'
  | 'MONTHLY'
  | 'AS_NEEDED';

export interface FoodSafetyProgramDoc {
  id: string;
  tenantId: string;
  kode: string;
  nama: string;
  description?: string;
  frequency: FoodSafetyProgramFrequency;
  /** Role operasional yang bertanggung jawab mencatat (informasional). */
  responsibleRole?: string;
  source: FoodSafetyProgramSource;
  aktif: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FoodSafetyRequirementDoc {
  id: string;
  tenantId: string;
  programId: string;
  programKode?: string;
  kode: string;
  nama: string;
  description?: string;
  /** Mapping BGN / internal — lebuh di requirement, bukan entity terpisah. */
  source: FoodSafetyProgramSource;
  sourceRef?: string;
  /** Gelombang D — grup UI PRE-01…05. */
  requirementGroup?: string;
  /** Kode pasal ringkas matrix, mis. BGN-6.x — bukan file PDF palsu. */
  bgnCode?: string;
  evidenceType?: string;
  sourceUrl?: string;
  aktif: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export const FOOD_SAFETY_PROGRAM_FREQUENCY_LABELS: Record<FoodSafetyProgramFrequency, string> = {
  PER_SHIFT: 'Per shift',
  DAILY: 'Harian',
  WEEKLY: 'Mingguan',
  MONTHLY: 'Bulanan',
  AS_NEEDED: 'Sesuai kebutuhan',
};

export const FOOD_SAFETY_PROGRAM_SOURCE_LABELS: Record<FoodSafetyProgramSource, string> = {
  BGN: 'BGN',
  INTERNAL: 'Internal',
};

export function normalizeFoodSafetyProgramFrequency(
  raw: unknown,
): FoodSafetyProgramFrequency | { error: string } {
  const v = String(raw || '').toUpperCase();
  if (
    v === 'PER_SHIFT'
    || v === 'DAILY'
    || v === 'WEEKLY'
    || v === 'MONTHLY'
    || v === 'AS_NEEDED'
  ) {
    return v;
  }
  return { error: 'frequency wajib PER_SHIFT | DAILY | WEEKLY | MONTHLY | AS_NEEDED' };
}

export function normalizeFoodSafetyProgramSource(
  raw: unknown,
): FoodSafetyProgramSource | { error: string } {
  const v = String(raw || 'INTERNAL').toUpperCase();
  if (v === 'BGN' || v === 'INTERNAL') return v;
  return { error: 'source wajib BGN | INTERNAL' };
}

/**
 * Periode checklist dari tanggal + frekuensi program.
 * DAILY → YYYY-MM-DD · WEEKLY → YYYY-Www · MONTHLY → YYYY-MM · selain itu → tanggal.
 */
export function resolveChecklistPeriod(
  tanggal: string,
  frequency: FoodSafetyProgramFrequency,
): string {
  const d = String(tanggal || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d || new Date().toISOString().slice(0, 10);
  if (frequency === 'DAILY' || frequency === 'PER_SHIFT' || frequency === 'AS_NEEDED') {
    return d;
  }
  if (frequency === 'MONTHLY') return d.slice(0, 7);
  // WEEKLY — ISO week
  const dt = new Date(`${d}T00:00:00.000Z`);
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((dt.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

type ProgramSeed = {
  kode: string;
  nama: string;
  description: string;
  frequency: FoodSafetyProgramFrequency;
  responsibleRole: string;
  requirements: Array<{ kode: string; nama: string; description?: string; sourceRef?: string }>;
};

/**
 * 11 program prerequisite (scope §5 / PRP umum SPPG).
 * Konten contoh untuk operasional — batas resmi ditetapkan pihak berkompeten.
 */
export const DEFAULT_FOOD_SAFETY_PROGRAMS: ProgramSeed[] = [
  {
    kode: 'PRP-HYG',
    nama: 'Hygiene Personel',
    description: 'Kebersihan diri, APD, dan kesehatan pekerja pangan',
    frequency: 'PER_SHIFT',
    responsibleRole: 'GUDANG',
    requirements: [
      { kode: 'HYG-01', nama: 'Cuci tangan & APD lengkap', sourceRef: 'BGN-PRP-HYG' },
      { kode: 'HYG-02', nama: 'Pekerja sehat / tidak infeksius', sourceRef: 'BGN-PRP-HYG' },
    ],
  },
  {
    kode: 'PRP-CLN',
    nama: 'Kebersihan & Sanitasi Fasilitas',
    description: 'Pembersihan area produksi, dapur, dan peralatan',
    frequency: 'DAILY',
    responsibleRole: 'GUDANG',
    requirements: [
      { kode: 'CLN-01', nama: 'Area produksi bersih sebelum mulai', sourceRef: 'BGN-PRP-CLN' },
      { kode: 'CLN-02', nama: 'Sanitasi permukaan kontak pangan', sourceRef: 'BGN-PRP-CLN' },
    ],
  },
  {
    kode: 'PRP-PEST',
    nama: 'Pengendalian Hama',
    description: 'Monitoring dan tindakan pengendalian hama',
    frequency: 'WEEKLY',
    responsibleRole: 'SUPERVISOR',
    requirements: [
      { kode: 'PEST-01', nama: 'Tidak ada tanda hama aktif', sourceRef: 'BGN-PRP-PEST' },
      { kode: 'PEST-02', nama: 'Perangkap/barrier terpasang & dicek', sourceRef: 'BGN-PRP-PEST' },
    ],
  },
  {
    kode: 'PRP-WATER',
    nama: 'Kualitas Air',
    description: 'Air proses, cuci, dan minum memenuhi syarat',
    frequency: 'WEEKLY',
    responsibleRole: 'SUPERVISOR',
    requirements: [
      { kode: 'WTR-01', nama: 'Sumber air layak / tidak keruh', sourceRef: 'BGN-PRP-WTR' },
    ],
  },
  {
    kode: 'PRP-RCV',
    nama: 'Penerimaan Bahan',
    description: 'Pemeriksaan bahan saat penerimaan',
    frequency: 'DAILY',
    responsibleRole: 'GUDANG',
    requirements: [
      { kode: 'RCV-01', nama: 'Kondisi kemasan & suhu terima OK', sourceRef: 'BGN-PRP-RCV' },
      { kode: 'RCV-02', nama: 'Identitas pemasok & tanggal tercatat', sourceRef: 'BGN-PRP-RCV' },
    ],
  },
  {
    kode: 'PRP-STOR',
    nama: 'Penyimpanan',
    description: 'Penataan, FIFO/FEFO, dan pemisahan bahan',
    frequency: 'DAILY',
    responsibleRole: 'GUDANG',
    requirements: [
      { kode: 'STOR-01', nama: 'FIFO/FEFO dipatuhi', sourceRef: 'BGN-PRP-STOR' },
      { kode: 'STOR-02', nama: 'Pemisahan bahan mentah/matang', sourceRef: 'BGN-PRP-STOR' },
    ],
  },
  {
    kode: 'PRP-WASTE',
    nama: 'Pengelolaan Limbah',
    description: 'Pembuangan sampah pangan dan non-pangan',
    frequency: 'DAILY',
    responsibleRole: 'GUDANG',
    requirements: [
      { kode: 'WST-01', nama: 'Sampah tertutup & dikosongkan terjadwal', sourceRef: 'BGN-PRP-WST' },
    ],
  },
  {
    kode: 'PRP-EQP',
    nama: 'Pemeliharaan Peralatan',
    description: 'Kondisi alat masak, timbang, dan pendingin',
    frequency: 'WEEKLY',
    responsibleRole: 'SUPERVISOR',
    requirements: [
      { kode: 'EQP-01', nama: 'Peralatan bersih & berfungsi', sourceRef: 'BGN-PRP-EQP' },
    ],
  },
  {
    kode: 'PRP-PKG',
    nama: 'Pengemasan & Label',
    description: 'Kemasan higienis dan label batch/tanggal',
    frequency: 'DAILY',
    responsibleRole: 'GUDANG',
    requirements: [
      { kode: 'PKG-01', nama: 'Kemasan rapat & higienis', sourceRef: 'BGN-PRP-PKG' },
      { kode: 'PKG-02', nama: 'Label batch/tanggal terpasang', sourceRef: 'BGN-PRP-PKG' },
    ],
  },
  {
    kode: 'PRP-DIST',
    nama: 'Transportasi / Distribusi',
    description: 'Kondisi angkut dan serah terima ke titik layanan',
    frequency: 'DAILY',
    responsibleRole: 'GUDANG',
    requirements: [
      { kode: 'DIST-01', nama: 'Suhu & waktu angkut aman', sourceRef: 'BGN-PRP-DIST' },
      { kode: 'DIST-02', nama: 'Dokumentasi serah terima lengkap', sourceRef: 'BGN-PRP-DIST' },
    ],
  },
  {
    kode: 'PRP-XCONT',
    nama: 'Pencegahan Kontaminasi Silang',
    description: 'Pemisahan alur, alat, dan area untuk cegah kontaminasi',
    frequency: 'PER_SHIFT',
    responsibleRole: 'GUDANG',
    requirements: [
      { kode: 'XCT-01', nama: 'Alat & area tidak bercampur raw/cooked', sourceRef: 'BGN-PRP-XCT' },
      { kode: 'XCT-02', nama: 'Tidak ada kontaminan kimia/fisik terlihat', sourceRef: 'BGN-PRP-XCT' },
    ],
  },
];
