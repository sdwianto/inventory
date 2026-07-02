/** Penyimpanan media lokal — logo tenant, foto aset (Fase 4). */

import { mkdir, writeFile, readFile, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { v4 as uuidv4 } from 'uuid';

const MAX_LOGO_BYTES = 512_000;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

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

  const buf = Buffer.from(data, 'base64');
  if (buf.length > maxBytes) return { error: `Gambar terlalu besar (max ${Math.round(maxBytes / 1024)}KB)` };

  const tid = String(tenantId || 'default').trim().toLowerCase();
  const filename = `${prefix}-${uuidv4()}.${extFromMime(mime)}`;
  const filePath = resolveMediaFilePath(tid, filename);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, buf);

  return { url: mediaPublicPath(tid, filename), filename };
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
