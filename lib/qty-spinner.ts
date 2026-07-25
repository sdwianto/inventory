/** Parse qty dari input (dukung koma desimal ID). */
export function parseQtyInput(raw: string | number): number {
  return Number(String(raw ?? '').trim().replace(',', '.'));
}

export function isWholeQty(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n - Math.round(n)) < 1e-9;
}

/**
 * Belanja / keluar stok = bilangan bulat.
 * Spinner: pecahan → ceil/floor dulu, baru ±1 pada klik berikutnya.
 * Contoh: 64,272 ↑ → 65; lalu ↑ → 66.
 */
export function stepQtyFromSpinner(prevRaw: string | number, direction: 'up' | 'down'): number {
  const prev = parseQtyInput(prevRaw);
  if (!Number.isFinite(prev) || prev < 0) return direction === 'up' ? 1 : 0;
  if (!isWholeQty(prev)) {
    return direction === 'up' ? Math.ceil(prev) : Math.max(0, Math.floor(prev));
  }
  const whole = Math.round(prev);
  return direction === 'up' ? whole + 1 : Math.max(0, whole - 1);
}

/** Deteksi perubahan dari native spinner mouse (±1) saat nilai masih pecahan. */
export function shouldSnapSpinnerStep(prev: number, next: number): boolean {
  return (
    Number.isFinite(prev)
    && Number.isFinite(next)
    && !isWholeQty(prev)
    && Math.abs(next - prev) >= 0.5
  );
}
