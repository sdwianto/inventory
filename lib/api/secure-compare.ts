// Perbandingan secret constant-time — hash dulu agar panjang input tidak bocor.

import crypto from 'crypto';

export function secureCompare(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
