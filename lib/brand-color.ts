// Warna brand dokumen (Surat Jalan/Faktur) per-tenant — resolusi warna, shade turunan, kontras teks.

/** Default lama Surat Jalan (Tailwind orange-500) — dipakai saat tenant belum set warnaBrand. */
export const DEFAULT_DELIVERY_BRAND = '#f97316';
/** Default lama Faktur (Tailwind blue-600) — dipakai saat tenant belum set warnaBrand. */
export const DEFAULT_INVOICE_BRAND = '#2563eb';

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function hexToRgb(hex?: string | null): [number, number, number] | null {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => clamp255(v).toString(16).padStart(2, '0')).join('')}`;
}

/** Gelapkan warna (0..1, 0 = tidak berubah, ~0.3 = jelas lebih gelap) — turunan border/aksen dari 1 warna dasar. */
export function darken(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return rgbToHex(rgb.map((c) => c * (1 - amount)) as [number, number, number]);
}

/** Hitam atau putih — mana yang lebih terbaca di atas warna latar ini (header tabel, dsb). */
export function readableTextOn(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#ffffff';
  return rgbToHex(readableTextRgbOn(rgb));
}

/** Sama seperti readableTextOn tapi sebagai RGB array (jsPDF headStyles.textColor). */
export function readableTextRgbOn(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? [31, 41, 55] : [255, 255, 255];
}

/** Normalisasi hex brand ke `#rrggbb` — CSS `borderColor`/`backgroundColor` butuh `#`. */
export function canonicalBrandHex(raw?: string | null): string | null {
  const rgb = hexToRgb(raw);
  return rgb ? rgbToHex(rgb) : null;
}

/** Warna brand tenant dari tenant settings, atau fallback default lama bila belum diset/tidak valid. */
export function resolveBrandColor(settings: unknown, fallback: string): string {
  const raw = (settings as { warnaBrand?: string } | null | undefined)?.warnaBrand;
  return canonicalBrandHex(raw) || fallback;
}

/** Sama seperti resolveBrandColor tapi sebagai RGB array (dipakai jsPDF: setTextColor/setDrawColor/fillColor). */
export function resolveBrandRgb(settings: unknown, fallbackRgb: [number, number, number]): [number, number, number] {
  const raw = (settings as { warnaBrand?: string } | null | undefined)?.warnaBrand;
  return hexToRgb(raw) || fallbackRgb;
}
