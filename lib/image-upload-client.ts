/** Kompres gambar di browser sebelum disimpan sebagai base64 (MongoDB). */

export const IMAGE_PICK_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_COMPRESS_MAX_DIM = 1200;
export const IMAGE_COMPRESS_QUALITY = 0.85;

export async function compressImageFile(
  file: File,
  maxDim = IMAGE_COMPRESS_MAX_DIM,
  quality = IMAGE_COMPRESS_QUALITY,
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

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
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
      canvas.width = Math.round(width);
      canvas.height = Math.round(height);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas tidak tersedia'));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      resolve(canvas.toDataURL(mime, quality));
    };
    img.onerror = () => reject(new Error('Gambar tidak valid'));
    img.src = dataUrl;
  });
}
