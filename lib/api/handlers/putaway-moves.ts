import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import { requireRole } from '@/lib/api/require-auth';
import {
  tenantIdForWrite,
  withTenantFilter,
  findMasterDoc,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { guardPosting } from '@/lib/api/period-lock';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { runInTransactionOrFallback } from '@/lib/api/transaction';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { isValidWarehouseKode, normalizeWarehouseKode, warehouseLabel } from '@/lib/api/warehouses';
import {
  PUTAWAY_MOVES_COLLECTION,
  assertPutawayBinsAktif,
  normalizePutawayLine,
  postPutawayMoveBins,
  type PutawayLine,
  type PutawayMoveDoc,
} from '@/lib/api/putaway-move';
import type { HandlerContext } from '@/types/api/handler';
import type { AuthContext } from '@/types/auth';

/** Warehouse ops: create / edit / post / cancel putaway. */
const MUTATE_ROLES = ['GUDANG', 'SUPERVISOR', 'ADMIN', 'OWNER', 'MASTER'] as const;

interface PutawayBody extends Record<string, unknown> {
  warehouseKode?: string;
  tanggal?: string | Date;
  keterangan?: string;
  lines?: Array<Partial<PutawayLine> | Record<string, unknown>>;
}

async function loadPutaway(
  db: HandlerContext['db'],
  scopeAuth: AuthContext | null,
  id: string,
): Promise<PutawayMoveDoc | null> {
  return db.collection(PUTAWAY_MOVES_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { id }),
  ) as Promise<PutawayMoveDoc | null>;
}

async function resolveLines(
  db: HandlerContext['db'],
  scopeAuth: AuthContext | null,
  tenantId: string,
  warehouseKode: string,
  rawLines: Array<Partial<PutawayLine> | Record<string, unknown>>,
): Promise<{ lines: PutawayLine[] } | { error: string }> {
  if (!rawLines.length) return { error: 'Minimal 1 baris putaway' };
  const lines: PutawayLine[] = [];
  for (const raw of rawLines) {
    const norm = normalizePutawayLine(raw);
    if (!norm.ok) return { error: norm.error };

    const bins = await assertPutawayBinsAktif(
      db, tenantId, warehouseKode, norm.line.fromBinKode, norm.line.toBinKode,
    );
    if (!bins.ok) return { error: bins.error };

    let line = { ...norm.line, fromBinKode: bins.fromBinKode, toBinKode: bins.toBinKode };
    const prod = await findMasterDoc(db, 'products', scopeAuth, { id: line.stokId });
    if (prod) {
      const p = prod as { kode?: string; nama?: string; satuan?: string };
      line = {
        ...line,
        kode: line.kode || String(p.kode || ''),
        nama: line.nama || String(p.nama || ''),
        satuan: line.satuan || String(p.satuan || ''),
      };
    }
    lines.push(line);
  }
  return { lines };
}

export async function handlePutawayMoves({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const putBody = (body || {}) as PutawayBody;

  if (route === '/putaway-moves' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    let filter: Record<string, unknown> = {};
    const status = url.searchParams.get('status');
    if (status) filter.status = status;
    const warehouseKodeRaw = url.searchParams.get('warehouseKode');
    if (warehouseKodeRaw) {
      const wh = normalizeWarehouseKode(warehouseKodeRaw);
      if (!isValidWarehouseKode(wh)) return err('Gudang tidak valid', 400);
      filter.warehouseKode = wh;
    }
    filter = withTenantFilter(scopeAuth, filter);

    const list = await db.collection(PUTAWAY_MOVES_COLLECTION)
      .find(filter)
      .sort({ tanggal: -1, createdAt: -1 })
      .limit(200)
      .toArray();
    return ok(list.map(clean));
  }

  if (route === '/putaway-moves' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MUTATE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: putBody, request });
    if (denied) return denied;
    if (!scopeAuth || !auth) return err('Unauthorized', 401);

    const warehouseKode = normalizeWarehouseKode(putBody.warehouseKode);
    if (!isValidWarehouseKode(warehouseKode)) {
      return err('Pilih gudang: GKERING, GBASAH, atau GJANITOR', 400);
    }
    const tenantId = tenantIdForWrite(scopeAuth, putBody);
    const resolved = await resolveLines(db, scopeAuth, tenantId, warehouseKode, putBody.lines || []);
    if ('error' in resolved) return err(resolved.error, 400);

    const now = new Date();
    const tanggal = putBody.tanggal ? new Date(putBody.tanggal) : now;
    if (Number.isNaN(tanggal.getTime())) return err('Tanggal tidak valid', 400);

    const noPutaway = await nextDocNumber(db, tenantId, 'PA', 'PA');
    const doc = stampTenantId(tenantId, {
      id: uuidv4(),
      noPutaway,
      warehouseKode,
      warehouseNama: warehouseLabel(warehouseKode),
      tanggal,
      status: 'DRAFT' as const,
      keterangan: String(putBody.keterangan || '').trim(),
      lines: resolved.lines,
      createdBy: { userId: auth.userId, userName: auth.name || auth.email, role: auth.role },
      createdAt: now,
      updatedAt: now,
    });
    await db.collection(PUTAWAY_MOVES_COLLECTION).insertOne(doc);
    return ok(clean(doc));
  }

  if (path[0] === 'putaway-moves' && path.length === 2 && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const doc = await loadPutaway(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    return ok(clean(doc));
  }

  if (path[0] === 'putaway-moves' && path.length === 2 && method === 'PUT') {
    const deniedRole = requireRole(auth, [...MUTATE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: putBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await loadPutaway(db, scopeAuth, path[1]);
    if (!existing) return err('Tidak ditemukan', 404);
    if (existing.status !== 'DRAFT') return err('Hanya DRAFT yang bisa diubah', 400);

    const warehouseKode = putBody.warehouseKode != null
      ? normalizeWarehouseKode(putBody.warehouseKode)
      : existing.warehouseKode;
    if (!isValidWarehouseKode(warehouseKode)) {
      return err('Pilih gudang: GKERING, GBASAH, atau GJANITOR', 400);
    }

    const tenantId = existing.tenantId || tenantIdForWrite(scopeAuth, putBody);
    const rawLines = putBody.lines != null ? putBody.lines : existing.lines;
    const resolved = await resolveLines(db, scopeAuth, tenantId, warehouseKode, rawLines || []);
    if ('error' in resolved) return err(resolved.error, 400);

    const update: Record<string, unknown> = {
      warehouseKode,
      warehouseNama: warehouseLabel(warehouseKode),
      lines: resolved.lines,
      updatedAt: new Date(),
    };
    if (putBody.keterangan !== undefined) {
      update.keterangan = String(putBody.keterangan || '').trim();
    }
    if (putBody.tanggal !== undefined) {
      const tanggal = new Date(putBody.tanggal);
      if (Number.isNaN(tanggal.getTime())) return err('Tanggal tidak valid', 400);
      update.tanggal = tanggal;
    }

    await db.collection(PUTAWAY_MOVES_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: existing.id, status: 'DRAFT' }),
      { $set: update },
    );
    return ok(clean(await loadPutaway(db, scopeAuth, existing.id)));
  }

  if (path[0] === 'putaway-moves' && path[2] === 'post' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MUTATE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: putBody, request });
    if (denied) return denied;
    if (!scopeAuth || !auth) return err('Unauthorized', 401);

    const existing = await loadPutaway(db, scopeAuth, path[1]);
    if (!existing) return err('Tidak ditemukan', 404);
    if (existing.status !== 'DRAFT') return err('Hanya DRAFT yang bisa di-post', 400);

    const locked = await guardPosting(db, scopeAuth, putBody, String(existing.tanggal || ''));
    if (locked) return locked;

    const warehouseKode = normalizeWarehouseKode(existing.warehouseKode);
    if (!isValidWarehouseKode(warehouseKode)) return err('Gudang tidak valid', 400);

    const tenantId = existing.tenantId || tenantIdForWrite(scopeAuth, putBody);
    const resolved = await resolveLines(db, scopeAuth, tenantId, warehouseKode, existing.lines || []);
    if ('error' in resolved) return err(resolved.error, 400);

    const now = new Date();
    try {
      await runInTransactionOrFallback(async ({ db: txDb, session }) => {
        const claim = await txDb.collection(PUTAWAY_MOVES_COLLECTION).updateOne(
          { id: existing.id, status: 'DRAFT' },
          {
            $set: {
              status: 'POSTED',
              lines: resolved.lines,
              postedAt: now,
              postedBy: { userId: auth.userId, userName: auth.name || auth.email, role: auth.role },
              updatedAt: now,
            },
          },
          session ? { session } : {},
        );
        if (claim.modifiedCount === 0) {
          throw new Error('Putaway sudah diproses oleh user lain');
        }
        await postPutawayMoveBins(
          txDb,
          tenantId,
          { warehouseKode, lines: resolved.lines, noPutaway: existing.noPutaway },
          session,
        );
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal post putaway';
      return err(msg, 400);
    }

    await writeAuditLog(db, {
      tenantId,
      action: 'PUTAWAY_POST',
      entityType: 'putaway_move',
      entityId: existing.id,
      summary: `Putaway ${existing.noPutaway} diposting (${warehouseKode})`,
      ...auditActor(auth),
      metadata: {
        noPutaway: existing.noPutaway,
        warehouseKode,
        lineCount: resolved.lines.length,
      },
    });
    return ok(clean(await loadPutaway(db, scopeAuth, existing.id)));
  }

  if (path[0] === 'putaway-moves' && path.length === 2 && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...MUTATE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: putBody, request });
    if (denied) return denied;

    const existing = await loadPutaway(db, scopeAuth, path[1]);
    if (!existing) return err('Tidak ditemukan', 404);
    if (existing.status !== 'DRAFT') return err('Hanya DRAFT yang bisa dibatalkan', 400);

    const now = new Date();
    await db.collection(PUTAWAY_MOVES_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: existing.id, status: 'DRAFT' }),
      { $set: { status: 'CANCELLED', cancelledAt: now, updatedAt: now } },
    );
    return ok(clean(await loadPutaway(db, scopeAuth, existing.id)));
  }

  return null;
}
