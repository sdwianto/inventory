/** Penyimpanan media lokal — logo tenant, foto aset (Fase 4). */

import { mkdir, writeFile, readFile, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { v4 as uuidv4 } from 'uuid';

const MAX_LOGO_BYTES = 512_000;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

function isServerlessReadOnlyFs() {
  const cwd = process.cwd();
  return Boolean(
    process.env.VERCEL
    || process.env.VERCEL_ENV
    || process.env.AWS_LAMBDA_FUNCTION_NAME
    || process.env.LAMBDA_TASK_ROOT
    || cwd.startsWith('/var/task'),
  );
}

function storageRoot() {
  const fromEnv = process.env.MEDIA_STORAGE_PATH?.trim();
  if (fromEnv) return fromEnv;
  return join(process.cwd(), 'storage', 'media');
}

function extFromMime(mime: string) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'jpg';
}

export function mediaPublicPath(tenantId: string, filename: string) {
  return `/api/media/${encodeURIComponent(tenantId)}/${encodeURIComponent(filename)}`;
}

export function resolveMediaFilePath(tenantId: string, filename: string) {
  const safeTenant = String(tenantId || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  const safeFile = String(filename || '').replace(/[^a-zA-Z0-9._-]/g, '');
  return join(storageRoot(), safeTenant, safeFile);
}

export async function storeImageBuffer(
  tenantId: string,
  buf: Buffer,
  {
    prefix = 'logo',
    maxBytes = MAX_LOGO_BYTES,
    mime = 'image/jpeg',
  }: { prefix?: string; maxBytes?: number; mime?: string } = {},
): Promise<{ url: string; filename: string } | { error: string }> {
  const normalizedMime = String(mime || 'image/jpeg').toLowerCase();
  if (!ALLOWED_MIME.has(normalizedMime)) return { error: 'Format gambar tidak didukung' };
  if (isServerlessReadOnlyFs()) {
    return { error: 'Media storage tidak tersedia di serverless' };
  }
  if (!buf?.length) return { error: 'Data gambar kosong' };
  if (buf.length > maxBytes) {
    return { error: `Gambar terlalu besar (max ${Math.round(maxBytes / 1024)}KB)` };
  }

  const tid = String(tenantId || 'default').trim().toLowerCase();
  const filename = `${prefix}-${uuidv4()}.${extFromMime(normalizedMime)}`;
  const filePath = resolveMediaFilePath(tid, filename);
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, buf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = /EACCES|EPERM|EROFS|permission denied/i.test(msg)
      ? ` — pastikan ${storageRoot()} writable (Docker: volume media_data + uid nextjs/1001)`
      : '';
    return { error: `Gagal menyimpan media: ${msg}${hint}` };
  }

  return { url: mediaPublicPath(tid, filename), filename };
}

export async function storeBase64Image(
  tenantId: string,
  base64: string,
  { prefix = 'logo', maxBytes = MAX_LOGO_BYTES }: { prefix?: string; maxBytes?: number } = {},
): Promise<{ url: string; filename: string } | { error: string }> {
  const raw = String(base64 || '').trim();
  if (!raw) return { error: 'Data gambar kosong' };

  let mime = 'image/png';
  let data = raw;
  const match = /^data:([^;]+);base64,(.+)$/i.exec(raw);
  if (match) {
    mime = match[1].toLowerCase();
    data = match[2];
  }
  if (!ALLOWED_MIME.has(mime)) return { error: 'Format gambar tidak didukung' };

  return storeImageBuffer(tenantId, Buffer.from(data, 'base64'), { prefix, maxBytes, mime });
}

/** Generic file store (PDF/Office/video) — allowlist by extension. */
const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export function mimeFromExt(ext: string): string | undefined {
  return EXT_MIME[String(ext || '').toLowerCase()];
}

export function extFromFileName(name: string): string {
  const base = String(name || '').split(/[/\\]/).pop() || '';
  const parts = base.split('.');
  if (parts.length < 2) return '';
  return parts.pop()!.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extFromMimeGeneric(mime: string): string | undefined {
  const m = String(mime || '').toLowerCase();
  for (const [ext, mm] of Object.entries(EXT_MIME)) {
    if (mm === m) return ext === 'jpeg' ? 'jpg' : ext;
  }
  if (m === 'image/jpg') return 'jpg';
  return undefined;
}

export async function storeFileBuffer(
  tenantId: string,
  buf: Buffer,
  {
    prefix = 'file',
    maxBytes,
    ext,
    mime,
  }: { prefix?: string; maxBytes: number; ext: string; mime?: string },
): Promise<{ url: string; filename: string; mimeType: string; sizeBytes: number } | { error: string }> {
  const normalizedExt = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const resolvedMime = mime || EXT_MIME[normalizedExt];
  if (!normalizedExt || !resolvedMime) return { error: 'Format file tidak didukung' };
  if (isServerlessReadOnlyFs()) {
    return { error: 'Media storage tidak tersedia di serverless' };
  }
  if (!buf?.length) return { error: 'Data file kosong' };
  if (buf.length > maxBytes) {
    return { error: `File terlalu besar (max ${Math.round(maxBytes / (1024 * 1024))}MB)` };
  }

  const tid = String(tenantId || 'default').trim().toLowerCase();
  const filename = `${prefix}-${uuidv4()}.${normalizedExt}`;
  const filePath = resolveMediaFilePath(tid, filename);
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, buf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = /EACCES|EPERM|EROFS|permission denied/i.test(msg)
      ? ` — pastikan ${storageRoot()} writable (Docker: volume media_data + uid nextjs/1001)`
      : '';
    return { error: `Gagal menyimpan media: ${msg}${hint}` };
  }

  return {
    url: mediaPublicPath(tid, filename),
    filename,
    mimeType: resolvedMime,
    sizeBytes: buf.length,
  };
}

/**
 * Persist base64 / data-URL file (non-image-only allowlist via `allowedExts`).
 * `originalName` dipakai untuk deteksi ekstensi bila MIME generik.
 */
export async function storeBase64File(
  tenantId: string,
  base64: string,
  {
    prefix = 'file',
    maxBytes,
    allowedExts,
    originalName,
  }: {
    prefix?: string;
    maxBytes: number;
    allowedExts: readonly string[];
    originalName?: string;
  },
): Promise<{ url: string; filename: string; mimeType: string; sizeBytes: number } | { error: string }> {
  const raw = String(base64 || '').trim();
  if (!raw) return { error: 'Data file kosong' };

  let mime = '';
  let data = raw;
  const match = /^data:([^;]+);base64,(.+)$/i.exec(raw);
  if (match) {
    mime = match[1].toLowerCase();
    data = match[2];
  }

  const allow = new Set(allowedExts.map((e) => e.toLowerCase()));
  let ext = originalName ? extFromFileName(originalName) : '';
  if (!ext && mime) ext = extFromMimeGeneric(mime) || '';
  if (!ext || !allow.has(ext)) {
    return { error: `Format file tidak diizinkan (${ext || mime || 'unknown'})` };
  }

  return storeFileBuffer(tenantId, Buffer.from(data, 'base64'), {
    prefix,
    maxBytes,
    ext,
    mime: EXT_MIME[ext],
  });
}

export async function readMediaFile(tenantId: string, filename: string) {
  const filePath = resolveMediaFilePath(tenantId, filename);
  return readFile(filePath);
}

export async function deleteMediaFile(tenantId: string, filename: string) {
  try {
    await unlink(resolveMediaFilePath(tenantId, filename));
  } catch {
    /* ignore missing */
  }
}

export function logoUrlFromSettings(settings: { logoUrl?: string; logoBase64?: string } | null | undefined) {
  if (settings?.logoUrl) return String(settings.logoUrl);
  return settings?.logoBase64 || '';
}
