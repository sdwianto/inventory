/** Serve file media tenant — GET /media/:tenantId/:filename */

import type { NextResponse } from 'next/server';
import { err } from '@/lib/api/db';
import { requireAuth, requireTenantAccess } from '@/lib/api/require-auth';
import { readMediaFile } from '@/lib/api/media-storage';
import type { HandlerContext } from '@/types/api/handler';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export async function handleMedia({
  route,
  method,
  path,
  auth,
}: HandlerContext): Promise<NextResponse | null> {
  if (path[0] !== 'media' || path.length !== 3 || method !== 'GET') return null;

  const denied = requireAuth(auth);
  if (denied) return denied;

  const tenantId = decodeURIComponent(path[1]);
  const filename = decodeURIComponent(path[2]);
  const accessDenied = requireTenantAccess(auth!, tenantId);
  if (accessDenied) return accessDenied;

  try {
    const buf = await readMediaFile(tenantId, filename);
    const ext = filename.split('.').pop()?.toLowerCase() || 'png';
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400, immutable',
      },
    }) as unknown as NextResponse;
  } catch {
    return err('File tidak ditemukan', 404);
  }
}
