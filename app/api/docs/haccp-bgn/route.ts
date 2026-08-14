import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { BGN_HACCP_SOURCE } from '@/lib/food-safety/prp-meta';

export const runtime = 'nodejs';

export async function GET() {
  const filePath = path.join(process.cwd(), BGN_HACCP_SOURCE.path);
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return NextResponse.json({ error: 'PDF BGN tidak ditemukan' }, { status: 404 });
    }
    const stream = Readable.toWeb(createReadStream(filePath));
    return new NextResponse(stream as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="HACCP-BGN.pdf"',
        'Cache-Control': 'public, max-age=86400',
        'Content-Length': String(info.size),
      },
    });
  } catch {
    return NextResponse.json(
      { error: 'PDF BGN tidak tersedia di server. Lihat docs/haccp/HACCP BGN.pdf di repositori.' },
      { status: 404 },
    );
  }
}
