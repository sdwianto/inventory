/**
 * Master personel operasional (karyawan / relawan).
 * Shared supporting domain — dikonsumsi dapur, pengadaan, logistics, keuangan.
 * Bukan mesin payroll; login tetap di `users`.
 */

export const PEOPLE_COLLECTION = 'people';
/** @deprecated alias — pakai PEOPLE_COLLECTION */
export const KITCHEN_PEOPLE_COLLECTION = PEOPLE_COLLECTION;
export const PERSON_PAYMENTS_COLLECTION = 'person_payments';
export const PERSON_CODE_PREFIX = 'KDP';
export const PERSON_CODE_DOC_TYPE = 'kitchen_person';
/** @deprecated alias */
export const KITCHEN_PERSON_CODE_PREFIX = PERSON_CODE_PREFIX;
export const KITCHEN_PERSON_CODE_DOC_TYPE = PERSON_CODE_DOC_TYPE;

export const PERSON_FOTO_MAX_BYTES = 1_000_000;
export const PERSON_DOC_MAX_BYTES = 8_000_000;
export const PERSON_FOTO_MAX_COUNT = 3;
export const PERSON_DOC_MAX_COUNT = 20;

export type KitchenPersonJenis = 'KARYAWAN' | 'RELAWAN';
export type KitchenPersonPeran =
  | 'PIC'
  | 'JURU_MASAK'
  | 'ASISTEN'
  | 'QC'
  | 'GUDANG'
  | 'DISTRIBUSI'
  | 'PENGEMUDI'
  | 'RELAWAN'
  | 'LAINNYA';

export const KITCHEN_PERSON_JENIS_LABELS: Record<KitchenPersonJenis, string> = {
  KARYAWAN: 'Staff',
  RELAWAN: 'Relawan',
};

export const KITCHEN_PERSON_PERAN_LABELS: Record<KitchenPersonPeran, string> = {
  PIC: 'PIC',
  JURU_MASAK: 'Juru masak',
  ASISTEN: 'Asisten',
  QC: 'QC',
  GUDANG: 'Gudang',
  DISTRIBUSI: 'Distribusi',
  PENGEMUDI: 'Pengemudi',
  RELAWAN: 'Relawan',
  LAINNYA: 'Lainnya',
};

export type PersonBankCode =
  | 'BCA'
  | 'MANDIRI'
  | 'BNI'
  | 'BRI'
  | 'BSI'
  | 'CIMB'
  | 'PERMATA'
  | 'DANAMON'
  | 'BTN'
  | 'BJB'
  | 'LAINNYA';

export const PERSON_BANK_CATALOG: Array<{ code: PersonBankCode; nama: string }> = [
  { code: 'BCA', nama: 'Bank BCA' },
  { code: 'MANDIRI', nama: 'Bank Mandiri' },
  { code: 'BNI', nama: 'Bank BNI' },
  { code: 'BRI', nama: 'Bank BRI' },
  { code: 'BSI', nama: 'Bank Syariah Indonesia' },
  { code: 'CIMB', nama: 'CIMB Niaga' },
  { code: 'PERMATA', nama: 'Bank Permata' },
  { code: 'DANAMON', nama: 'Bank Danamon' },
  { code: 'BTN', nama: 'Bank BTN' },
  { code: 'BJB', nama: 'Bank BJB' },
  { code: 'LAINNYA', nama: 'Bank lain' },
];

export type PersonBankAccount = {
  bankCode: PersonBankCode;
  bankNama: string;
  accountNo: string;
  accountName: string;
  isPrimary: boolean;
};

export type KitchenPersonAttachmentKind =
  | 'FOTO'
  | 'IDENTITAS'
  | 'SERTIFIKAT'
  | 'LAMARAN'
  | 'KONTRAK'
  | 'LAINNYA';

export const PERSON_ATTACHMENT_KIND_LABELS: Record<KitchenPersonAttachmentKind, string> = {
  FOTO: 'Foto',
  IDENTITAS: 'Identitas / KTP',
  SERTIFIKAT: 'Sertifikat',
  LAMARAN: 'Surat lamaran',
  KONTRAK: 'Kontrak kerja',
  LAINNYA: 'Lainnya',
};

export type KitchenPersonAttachment = {
  id: string;
  kind: KitchenPersonAttachmentKind;
  title: string;
  originalName?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  issuedAt?: string;
  expiresAt?: string;
  uploadedAt: Date;
  uploadedBy?: string;
  uploadedByName?: string;
};

export interface KitchenPersonDoc {
  id: string;
  tenantId: string;
  kode: string;
  nama: string;
  jenis: KitchenPersonJenis;
  peran: KitchenPersonPeran;
  jabatan?: string;
  nik?: string;
  noTelp?: string;
  kitchenIds: string[];
  bankAccounts: PersonBankAccount[];
  userId?: string;
  aktif: boolean;
  effectiveFrom?: string;
  effectiveTo?: string;
  attachments: KitchenPersonAttachment[];
  createdAt: Date;
  updatedAt: Date;
}

export type PersonSnapshot = {
  personId: string;
  kode?: string;
  nama: string;
  nik?: string;
  jabatan?: string;
  jenis?: KitchenPersonJenis;
};

const BANK_CODE_SET = new Set<string>(PERSON_BANK_CATALOG.map((b) => b.code));
const JENIS_SET = new Set<string>(['KARYAWAN', 'RELAWAN']);
const PERAN_SET = new Set<string>(Object.keys(KITCHEN_PERSON_PERAN_LABELS));
const ATTACH_KIND_SET = new Set<string>(Object.keys(PERSON_ATTACHMENT_KIND_LABELS));

export function bankNamaForCode(code: PersonBankCode): string {
  return PERSON_BANK_CATALOG.find((b) => b.code === code)?.nama || code;
}

export function normalizePersonNama(raw: unknown): string {
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

/** NIK wajib, format bebas (kode internal / KTP / dll). Kosong = invalid. */
export const PERSON_NIK_MAX_LEN = 64;

export function normalizeNik(raw: unknown): string | null {
  const nik = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!nik) return null;
  if (nik.length > PERSON_NIK_MAX_LEN) return null;
  return nik;
}

export function normalizeAccountNo(raw: unknown): string {
  return String(raw || '').replace(/\D/g, '');
}

export function normalizeBankCode(raw: unknown): PersonBankCode | null {
  const code = String(raw || '').trim().toUpperCase();
  if (!code) return null;
  if (BANK_CODE_SET.has(code)) return code as PersonBankCode;
  return null;
}

export function normalizeJenis(raw: unknown): KitchenPersonJenis {
  const v = String(raw || '').trim().toUpperCase();
  return JENIS_SET.has(v) ? (v as KitchenPersonJenis) : 'KARYAWAN';
}

export function normalizePeran(raw: unknown): KitchenPersonPeran {
  const v = String(raw || '').trim().toUpperCase();
  return PERAN_SET.has(v) ? (v as KitchenPersonPeran) : 'LAINNYA';
}

export function normalizeAttachmentKind(raw: unknown): KitchenPersonAttachmentKind | null {
  const v = String(raw || '').trim().toUpperCase();
  if (!ATTACH_KIND_SET.has(v)) return null;
  return v as KitchenPersonAttachmentKind;
}

export function normalizeKitchenIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const id = String(item || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function ymd(value: Date | string): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const s = String(value || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

export function normalizeIsoDate(raw: unknown): string | undefined {
  const s = ymd(String(raw || ''));
  return s || undefined;
}

export function isPersonEffective(
  doc: Pick<KitchenPersonDoc, 'aktif' | 'effectiveFrom' | 'effectiveTo'>,
  onDate?: Date | string,
): boolean {
  if (doc.aktif === false) return false;
  const day = ymd(onDate || new Date()) || ymd(new Date());
  const from = String(doc.effectiveFrom || '').trim().slice(0, 10);
  const to = String(doc.effectiveTo || '').trim().slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

export function resolvePersonSnapshot(
  doc: KitchenPersonDoc,
  onDate?: Date | string,
): PersonSnapshot | { error: string } {
  if (!doc?.id || !normalizePersonNama(doc.nama)) {
    return { error: 'Personel tidak valid' };
  }
  if (doc.aktif === false) return { error: 'Personel nonaktif' };
  if (!isPersonEffective(doc, onDate)) return { error: 'Personel di luar masa tugas' };
  return {
    personId: doc.id,
    kode: doc.kode,
    nama: normalizePersonNama(doc.nama),
    ...(doc.nik ? { nik: doc.nik } : {}),
    ...(doc.jabatan ? { jabatan: doc.jabatan } : {}),
    jenis: doc.jenis,
  };
}

export function assertBankAccounts(raw: unknown): PersonBankAccount[] | { error: string } {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: 'Rekening bank tidak valid' };
  const out: PersonBankAccount[] = [];
  const keys = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] && typeof raw[i] === 'object' ? raw[i] as Record<string, unknown> : {};
    const bankCode = normalizeBankCode(row.bankCode);
    if (!bankCode) return { error: `Rekening #${i + 1}: bank tidak dikenali` };
    const accountNo = normalizeAccountNo(row.accountNo);
    if (accountNo.length < 6 || accountNo.length > 20) {
      return { error: `Rekening #${i + 1}: nomor rekening 6–20 digit` };
    }
    const accountName = normalizePersonNama(row.accountName);
    if (!accountName) return { error: `Rekening #${i + 1}: nama rekening wajib` };
    const key = `${bankCode}::${accountNo}`;
    if (keys.has(key)) return { error: `Rekening ${bankCode} ${accountNo} duplikat` };
    keys.add(key);
    out.push({
      bankCode,
      bankNama: String(row.bankNama || '').trim() || bankNamaForCode(bankCode),
      accountNo,
      accountName,
      isPrimary: row.isPrimary === true,
    });
  }
  if (!out.length) return [];
  const primaries = out.filter((a) => a.isPrimary);
  if (primaries.length > 1) return { error: 'Hanya satu rekening yang boleh primary' };
  if (primaries.length === 0) out[0].isPrimary = true;
  return out;
}

export function attachmentCounts(attachments: KitchenPersonAttachment[] | undefined) {
  const list = attachments || [];
  const foto = list.filter((a) => a.kind === 'FOTO').length;
  const docs = list.length - foto;
  return { foto, docs, total: list.length };
}

export function assertCanAddAttachment(
  existing: KitchenPersonAttachment[] | undefined,
  kind: KitchenPersonAttachmentKind,
): string | null {
  const { foto, docs } = attachmentCounts(existing);
  if (kind === 'FOTO' && foto >= PERSON_FOTO_MAX_COUNT) {
    return `Maksimal ${PERSON_FOTO_MAX_COUNT} foto`;
  }
  if (kind !== 'FOTO' && docs >= PERSON_DOC_MAX_COUNT) {
    return `Maksimal ${PERSON_DOC_MAX_COUNT} dokumen`;
  }
  return null;
}

export function estimateBase64Bytes(raw: unknown): number {
  const s = String(raw || '');
  const i = s.indexOf(',');
  const b64 = i >= 0 ? s.slice(i + 1) : s;
  if (!b64) return 0;
  return Math.floor((b64.length * 3) / 4);
}

export function isFotoMime(raw: unknown): boolean {
  const mime = String(raw || '').toLowerCase();
  return mime === 'image/jpeg' || mime === 'image/jpg' || mime === 'image/png' || mime === 'image/webp';
}

export function publicAttachment(att: KitchenPersonAttachment) {
  return {
    id: att.id,
    kind: att.kind,
    title: att.title,
    originalName: att.originalName,
    mimeType: att.mimeType,
    sizeBytes: att.sizeBytes,
    issuedAt: att.issuedAt,
    expiresAt: att.expiresAt,
    uploadedAt: att.uploadedAt,
    uploadedByName: att.uploadedByName,
  };
}

export function projectPersonList(doc: KitchenPersonDoc) {
  const { attachments, ...rest } = doc;
  return {
    ...rest,
    attachmentCount: (attachments || []).length,
  };
}

export function projectPersonDetail(
  doc: KitchenPersonDoc,
  pay?: { paymentCount?: number; lastPaidAt?: Date | string | null; lastPaidAmount?: number },
) {
  return {
    ...doc,
    attachments: (doc.attachments || []).map(publicAttachment),
    attachmentCount: (doc.attachments || []).length,
    paymentCount: Number(pay?.paymentCount || 0),
    lastPaidAt: pay?.lastPaidAt || null,
    lastPaidAmount: Number(pay?.lastPaidAmount || 0),
  };
}
