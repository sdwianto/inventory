/** Serve file media tenant — GET /media/:tenantId/:filename (publik baca untuk sync foto katalog). */

import type { NextResponse } from 'next/server';
import { err } from '@/lib/api/db';
import { readMediaFile } from '@/lib/api/media-storage';
import type { HandlerContext } from '@/types/api/handler';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

const INLINE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'mp4', 'webm']);

export async function handleMedia({
  method,
  path,
}: HandlerContext): Promise<NextResponse | null> {
  if (path[0] !== 'media' || path.length !== 3 || method !== 'GET') return null;

  const tenantId = decodeURIComponent(path[1]);
  const filename = decodeURIComponent(path[2]);
  try {
    const buf = await readMediaFile(tenantId, filename);
    const ext = filename.split('.').pop()?.toLowerCase() || 'png';
    const contentType = MIME[ext] || 'application/octet-stream';
    const disposition = INLINE_EXT.has(ext) ? 'inline' : `attachment; filename="${filename}"`;
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': disposition,
        'Cache-Control': 'public, max-age=86400, immutable',
      },
    }) as unknown as NextResponse;
  } catch {
    return err('File tidak ditemukan', 404);
  }
}
