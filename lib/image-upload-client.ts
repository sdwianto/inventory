/** Kompres gambar di browser sebelum upload (target di bawah batas server). */

export const IMAGE_PICK_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_COMPRESS_MAX_DIM = 1200;
export const IMAGE_COMPRESS_QUALITY = 0.85;
/** Default target size (under server maxBytes 768_000 for QC/HACCP). */
export const IMAGE_COMPRESS_TARGET_BYTES = 700 * 1024;

function dataUrlByteLength(dataUrl: string): number {
  const i = dataUrl.indexOf(',');
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  return Math.floor((b64.length * 3) / 4);
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Gambar tidak valid'));
    img.src = dataUrl;
  });
}

function drawToDataUrl(
  img: HTMLImageElement,
  maxDim: number,
  quality: number,
  forceJpeg: boolean,
): string {
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    if (width > height) {
      height = (height * maxDim) / width;
      width = maxDim;
    } else {
      width = (width * maxDim) / height;
      height = maxDim;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas tidak tersedia');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const mime = forceJpeg ? 'image/jpeg' : 'image/jpeg';
  return canvas.toDataURL(mime, quality);
}

/**
 * Resize + kompres berulang sampai di bawah targetBytes (atau dimensi/quality minimum).
 */
export async function compressImageFile(
  file: File,
  maxDim = IMAGE_COMPRESS_MAX_DIM,
  quality = IMAGE_COMPRESS_QUALITY,
  targetBytes = IMAGE_COMPRESS_TARGET_BYTES,
): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('File harus berupa gambar');
  }
  if (file.size > IMAGE_PICK_MAX_BYTES) {
    throw new Error('Gambar terlalu besar (maks. 5MB sebelum kompresi)');
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve(String(ev.target?.result ?? ''));
    reader.onerror = () => reject(new Error('Gagal membaca file'));
    reader.readAsDataURL(file);
  });

  const img = await loadImage(dataUrl);
  let dim = maxDim;
  let q = quality;
  let out = drawToDataUrl(img, dim, q, true);

  // Iteratively shrink until under target (or floor reached).
  for (let i = 0; i < 8 && dataUrlByteLength(out) > targetBytes; i++) {
    if (q > 0.45) {
      q = Math.max(0.45, q - 0.1);
    } else if (dim > 640) {
      dim = Math.max(640, Math.round(dim * 0.75));
      q = Math.min(0.8, q + 0.05);
    } else if (dim > 480) {
      dim = 480;
      q = 0.5;
    } else {
      dim = 400;
      q = 0.4;
      out = drawToDataUrl(img, dim, q, true);
      break;
    }
    out = drawToDataUrl(img, dim, q, true);
  }

  if (dataUrlByteLength(out) > targetBytes) {
    // Last resort smaller frame
    out = drawToDataUrl(img, 360, 0.35, true);
  }

  return out;
}
