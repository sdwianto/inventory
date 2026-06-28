/** Validasi foto base64 untuk disimpan di MongoDB. */

export const MAX_BASE64_IMAGE_LEN = 700_000;
export const MAX_WR_PHOTOS = 5;

function isDataUrlImage(value: string): boolean {
  return /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(value);
}

export function validateBase64Image(
  value: unknown,
  label = 'Foto',
): string | null | { error: string } {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!isDataUrlImage(s)) {
    return { error: `${label} harus berformat gambar base64` };
  }
  if (s.length > MAX_BASE64_IMAGE_LEN) {
    return { error: `${label} terlalu besar — kompres atau gunakan resolusi lebih kecil` };
  }
  return s;
}

export function validateBase64Images(
  value: unknown,
  maxCount = MAX_WR_PHOTOS,
): string[] | { error: string } {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return { error: 'Format foto tidak valid' };
  if (value.length > maxCount) {
    return { error: `Maksimal ${maxCount} foto` };
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const checked = validateBase64Image(value[i], `Foto ${i + 1}`);
    if (checked && typeof checked === 'object' && 'error' in checked) return checked;
    if (typeof checked === 'string') out.push(checked);
  }
  return out;
}
