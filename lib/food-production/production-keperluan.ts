/**
 * Pure helpers for classifying operational release "keperluan".
 * Client-safe — no next/headers, mongodb, or tenant-master imports.
 */

const PRODUCTION_KEPERLUAN_RE = /produksi|masak|menu|dapur|porsi|bahan|ayam|ikan|siomay|kremes|katsu|rolade|nasi|sayur|telur|tempe|tahu|sapi|udang|bumbu/i;

/** Keperluan yang bukan konsumsi bahan produksi — skip infer/link wajib. */
export function isExcludedOperationalKeperluan(keperluan: string): boolean {
  const k = String(keperluan || '').trim();
  if (!k) return false;
  return /cuci|opname|maintenance|janitor|service\s*ac|perbaikan|stok\s*opname/i.test(k);
}

/** Keperluan RL terlihat untuk bahan produksi — wajib link rencana. */
export function looksLikeProductionKeperluan(keperluan: string): boolean {
  const k = String(keperluan || '').trim();
  if (!k || isExcludedOperationalKeperluan(k)) return false;
  return PRODUCTION_KEPERLUAN_RE.test(k);
}

/** Rentang hari rencana (UTC+7) untuk cocokkan tanggal RL. */
export function planDayWindowWib(planTanggal: string): { start: Date; end: Date } {
  const t = String(planTanggal || '').slice(0, 10);
  return {
    start: new Date(`${t}T00:00:00.000+07:00`),
    end: new Date(`${t}T23:59:59.999+07:00`),
  };
}
