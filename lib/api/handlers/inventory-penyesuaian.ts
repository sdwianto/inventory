import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  findMasterDoc,
  resolveOperationalScope,
  tenantIdForWrite,
} from '@/lib/api/tenant-master';
import {
  withOperationalFilter,
  stampTenantId,
} from '@/lib/api/tenant-operational';
import { assertOperationalAccess } from '@/lib/api/tenant-validate';
import { requireRole, STOCK_ADJUST_ROLES, STOCK_ADJUST_DRAFT_ROLES } from '@/lib/api/require-auth';
import { guardPosting } from '@/lib/api/period-lock';
import { warehouseLabel } from '@/lib/api/warehouses';
import { runInTransactionOnDb, txOpts } from '@/lib/api/transaction';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { resolveProductGudangKode } from '@/lib/api/product-warehouse';
import { resolveLineQtyBase } from '@/lib/uom/resolve-line-qty';
import { writeAuditLog } from '@/lib/api/audit-log';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import { casConflict, casEditFilter, casStatusFilter, CasConflictError, isCasConflict } from '@/lib/api/cas';
import { docIdFilter } from '@/lib/api/doc-filter';
import {
  ADJUSTMENT_REASON_CODES,
  ADJUSTMENT_REASON_LABELS,
  actorFromAuth,
  adjustmentReasonError,
  postAdjustmentLines,
  selfApprovalState,
  snapshotQtySistem,
  type AdjustmentLine,
  type AdjustmentStatus,
} from '@/lib/api/stock-adjustment';
import type { HandlerContext } from '@/types/api/handler';
import type { AuthContext } from '@/types/auth';
import type { Db } from 'mongodb';
import { asProductRow, itemStokId, type InventoryBody } from './inventory-shared';

const COLLECTION = 'penyesuaian_stok';

type AdjustmentDoc = {
  id: string;
  tenantId?: string;
  noPenyesuaian?: string;
  status?: AdjustmentStatus;
  reasonCode?: string;
  keterangan?: string;
  items?: AdjustmentLine[];
  createdBy?: { userId?: string; userName?: string };
  submittedBy?: { userId?: string; userName?: string };
  /** Semua pengguna yang pernah mengubah draft — ikut dihitung pembuat untuk maker-checker. */
  editorIds?: string[];
  updatedAt?: Date | null;
  [key: string]: unknown;
};

type ParsedLine = AdjustmentLine;

function adjustmentMakers(doc: AdjustmentDoc) {
  return [doc.createdBy, doc.submittedBy, ...(doc.editorIds || []).map((userId) => ({ userId }))];
}

/** Susun baris dari body: produk, gudang home, konversi satuan ke base. qtyAktual boleh kosong untuk draft. */
async function parseLines(
  db: Db,
  scopeAuth: AuthContext | null,
  tenantId: string,
  items: Array<Record<string, unknown>>,
  opts: { requireAktual: boolean; snapshot: boolean },
): Promise<{ lines: ParsedLine[]; lokasi: string } | { error: string; status: number }> {
  const uomsCache = new Map<string, import('@/lib/uom/types').ProductUom[]>();
  const seen = new Set<string>();
  const lines: ParsedLine[] = [];
  let lokasi = '';
  for (const it of items) {
    const stokId = itemStokId(it);
    const prodRaw = await findMasterDoc(db, 'products', scopeAuth, { id: stokId });
    if (!prodRaw) return { error: `Produk ${String(it.kode || stokId)} tidak ditemukan`, status: 404 };
    const prod = asProductRow(prodRaw);
    if ((prodRaw as { deletedAt?: unknown }).deletedAt) return { error: `Produk ${prod.kode || stokId} sudah dihapus`, status: 400 };
    if (seen.has(prod.id)) return { error: `Produk ${prod.kode || prod.id} muncul lebih dari sekali — satukan dalam satu baris`, status: 400 };
    seen.add(prod.id);
    const rawAktual = it.qtyAktual;
    const hasAktual = rawAktual !== undefined && rawAktual !== null && String(rawAktual).trim() !== '';
    if (!hasAktual && opts.requireAktual) return { error: `Qty aktual ${prod.kode || prod.id} wajib diisi`, status: 400 };
    let qtyAktual: number | null = null;
    let qtyEntered: number | null = null;
    let uomId = (it as { uomId?: string }).uomId;
    let satuan = (it as { satuan?: string }).satuan;
    if (hasAktual) {
      const resolved = await resolveLineQtyBase(db, tenantId, prod.id, {
        qty: String(rawAktual),
        uomId,
        satuan,
      }, uomsCache);
      if ('error' in resolved) return { error: resolved.error, status: 400 };
      if (!(resolved.qtyBase >= 0)) return { error: `Qty aktual ${prod.kode || prod.id} tidak boleh negatif`, status: 400 };
      qtyAktual = resolved.qtyBase;
      qtyEntered = resolved.qty;
      uomId = resolved.uomId;
      satuan = resolved.satuan;
    }
    const gudangKode = resolveProductGudangKode(prod);
    const lokasiLabel = `${gudangKode} - ${warehouseLabel(gudangKode)}`;
    if (!lokasi) lokasi = lokasiLabel;
    else if (lokasi !== lokasiLabel) lokasi = 'Multi gudang';
    lines.push({
      stokId: prod.id,
      kode: prod.kode,
      nama: prod.nama,
      satuan: satuan || prod.satuan,
      uomId,
      qtyEntered,
      gudangKode,
      qtySistem: opts.snapshot ? await snapshotQtySistem(db, tenantId, prod.id, gudangKode) : 0,
      qtyAktual,
    });
  }
  return { lines, lokasi };
}

/** Baris draft yang diedit: pertahankan snapshot qtySistem baris yang sudah ada, snapshot baru untuk baris tambahan. */
function mergeDraftLines(prev: AdjustmentLine[], next: ParsedLine[]): AdjustmentLine[] {
  const byId = new Map(prev.map((l) => [l.stokId, l]));
  return next.map((l) => {
    const old = byId.get(l.stokId);
    if (!old || old.gudangKode !== l.gudangKode) return l;
    return { ...l, qtySistem: old.qtySistem };
  });
}

export async function handlePenyesuaian({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const invBody = (body || {}) as InventoryBody & {
    reasonCode?: string;
    submit?: boolean;
    reason?: string;
    updatedAt?: string;
  };

  if (route === '/stok/penyesuaian/config' && method === 'GET') {
    const deniedRole = requireRole(auth, STOCK_ADJUST_DRAFT_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const tenantId = tenantIdForWrite(scopeAuth, {});
    const approvalRequired = await isTenantFeatureEnabled(db, tenantId, 'adjustmentApproval');
    return ok({
      approvalRequired,
      reasonCodes: ADJUSTMENT_REASON_CODES.map((code) => ({ code, label: ADJUSTMENT_REASON_LABELS[code] })),
    });
  }

  if (route === '/stok/penyesuaian' && method === 'GET') {
    const deniedRole = requireRole(auth, STOCK_ADJUST_DRAFT_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const list = await db.collection(COLLECTION)
      .find(withOperationalFilter(scopeAuth, {}))
      .sort({ tanggal: -1 })
      .limit(200)
      .toArray();
    return ok(list.map(clean));
  }

  if (route === '/stok/penyesuaian' && method === 'POST') {
    const deniedRole = requireRole(auth, STOCK_ADJUST_DRAFT_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: invBody, request });
    if (denied) return denied;
    const items = invBody.items || [];
    if (items.length === 0) return err('Tidak ada item');
    const tenantId = tenantIdForWrite(scopeAuth, invBody);
    const approvalRequired = await isTenantFeatureEnabled(db, tenantId, 'adjustmentApproval');
    const actor = actorFromAuth(auth);
    const now = new Date();

    if (approvalRequired) {
      const submit = invBody.submit === true;
      if (submit) {
        const reasonErr = adjustmentReasonError(invBody.reasonCode, invBody.keterangan);
        if (reasonErr) return err(reasonErr, 400);
      }
      const parsed = await parseLines(db, scopeAuth, tenantId, items, { requireAktual: submit, snapshot: true });
      if ('error' in parsed) return err(parsed.error, parsed.status);
      const doc: AdjustmentDoc = stampTenantId(tenantId, {
        id: uuidv4(),
        noPenyesuaian: '',
        status: (submit ? 'PENDING_APPROVAL' : 'DRAFT') as AdjustmentStatus,
        tanggal: now,
        snapshotAt: now,
        lokasi: parsed.lokasi,
        reasonCode: invBody.reasonCode || null,
        keterangan: invBody.keterangan || '',
        userId: actor.userId,
        userName: actor.userName,
        createdBy: actor,
        ...(submit ? { submittedBy: actor, submittedAt: now } : {}),
        items: parsed.lines,
        createdAt: now,
        updatedAt: now,
      }) as AdjustmentDoc;
      try {
        await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
          doc.noPenyesuaian = await nextDocNumber(txDb, tenantId, 'PS', 'PS', session);
          await txDb.collection(COLLECTION).insertOne({ ...doc }, txOpts(session));
          await writeAuditLog(txDb, {
            tenantId,
            action: submit ? 'STOCK_ADJUSTMENT_SUBMITTED' : 'STOCK_ADJUSTMENT_DRAFT',
            entityType: COLLECTION,
            entityId: doc.id,
            summary: `Penyesuaian ${doc.noPenyesuaian} ${submit ? 'diajukan' : 'disimpan sebagai draft'} (${parsed.lines.length} item)`,
            userId: actor.userId,
            userName: actor.userName,
            metadata: { noPenyesuaian: doc.noPenyesuaian, reasonCode: doc.reasonCode, itemCount: parsed.lines.length },
          }, session);
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : 'Gagal menyimpan penyesuaian stok', 400);
      }
      return ok(clean(doc));
    }

    // Tanpa approval: posting langsung, hanya Supervisor+.
    const deniedPost = requireRole(auth, STOCK_ADJUST_ROLES);
    if (deniedPost) return deniedPost;
    const reasonErr = adjustmentReasonError(invBody.reasonCode, invBody.keterangan);
    if (reasonErr) return err(reasonErr, 400);
    const locked = await guardPosting(db, scopeAuth, invBody);
    if (locked) return locked;
    const parsed = await parseLines(db, scopeAuth, tenantId, items, { requireAktual: true, snapshot: false });
    if ('error' in parsed) return err(parsed.error, parsed.status);
    const costingV2 = await isTenantFeatureEnabled(db, tenantId, 'costingV2');
    const doc: AdjustmentDoc = stampTenantId(tenantId, {
      id: uuidv4(),
      noPenyesuaian: '',
      status: 'POSTED' as AdjustmentStatus,
      tanggal: now,
      lokasi: parsed.lokasi,
      reasonCode: invBody.reasonCode,
      keterangan: invBody.keterangan || '',
      userId: actor.userId,
      userName: actor.userName,
      createdBy: actor,
      postedAt: now,
      items: [] as AdjustmentLine[],
      createdAt: now,
      updatedAt: now,
    }) as AdjustmentDoc;
    try {
      await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
        // Callback bisa diulang (transient error) — state dokumen dibangun ulang tiap percobaan.
        const noPS = await nextDocNumber(txDb, tenantId, 'PS', 'PS', session);
        doc.noPenyesuaian = noPS;
        doc.items = await postAdjustmentLines(txDb, session, {
          tenantId, docId: doc.id, noPS, lines: parsed.lines, mode: 'IMMEDIATE', now, actor, costingV2,
        });
        await txDb.collection(COLLECTION).insertOne({ ...doc }, txOpts(session));
        await writeAuditLog(txDb, {
          tenantId,
          action: 'STOCK_ADJUSTMENT',
          entityType: COLLECTION,
          entityId: doc.id,
          summary: `Penyesuaian ${noPS} (${parsed.lines.length} item)`,
          userId: actor.userId,
          userName: actor.userName,
          metadata: { noPenyesuaian: noPS, reasonCode: doc.reasonCode, itemCount: parsed.lines.length },
        }, session);
      });
    } catch (e) {
      return err(e instanceof Error ? e.message : 'Gagal menyimpan penyesuaian stok', 400);
    }
    await invalidateDashboardSnapshot(db, tenantId);
    return ok(clean(doc));
  }

  if (path[0] === 'stok' && path[1] === 'penyesuaian' && path.length === 3 && method === 'GET') {
    const deniedRole = requireRole(auth, STOCK_ADJUST_DRAFT_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const access = await assertOperationalAccess(db, scopeAuth, COLLECTION, { id: path[2] });
    if ('error' in access) return access.error;
    return ok(clean(access.doc));
  }

  // Edit draft: qty hasil hitung, alasan, catatan, tambah/hapus baris.
  if (path[0] === 'stok' && path[1] === 'penyesuaian' && path.length === 3 && method === 'PUT') {
    const deniedRole = requireRole(auth, STOCK_ADJUST_DRAFT_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: invBody, request });
    if (denied) return denied;
    const access = await assertOperationalAccess(db, scopeAuth, COLLECTION, { id: path[2] });
    if ('error' in access) return access.error;
    const doc = access.doc as unknown as AdjustmentDoc;
    if (doc.status !== 'DRAFT') return err('Hanya draft yang bisa diubah', 400);
    const tenantId = String(doc.tenantId || tenantIdForWrite(scopeAuth, invBody));
    const items = invBody.items || [];
    if (items.length === 0) return err('Tidak ada item');
    const parsed = await parseLines(db, scopeAuth, tenantId, items, { requireAktual: false, snapshot: true });
    if ('error' in parsed) return err(parsed.error, parsed.status);
    const actor = actorFromAuth(auth);
    const now = new Date();
    try {
      await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
        const res = await txDb.collection(COLLECTION).updateOne(
          casEditFilter(doc),
          {
            $set: {
              items: mergeDraftLines(doc.items || [], parsed.lines),
              lokasi: parsed.lokasi,
              reasonCode: invBody.reasonCode ?? doc.reasonCode ?? null,
              keterangan: invBody.keterangan ?? doc.keterangan ?? '',
              updatedAt: now,
              updatedBy: actor,
            },
            $addToSet: { editorIds: actor.userId },
          },
          txOpts(session),
        );
        if (res.matchedCount === 0) throw new CasConflictError();
      });
    } catch (e) {
      if (isCasConflict(e)) return casConflict(e.message);
      return err(e instanceof Error ? e.message : 'Gagal menyimpan draft', 400);
    }
    const fresh = await db.collection(COLLECTION).findOne(docIdFilter(doc));
    return ok(clean(fresh));
  }

  if (path[0] === 'stok' && path[1] === 'penyesuaian' && path.length === 4 && method === 'POST') {
    const action = path[3];
    if (!['submit', 'approve', 'reject', 'cancel'].includes(action)) return null;
    const needRoles = action === 'approve' || action === 'reject' ? STOCK_ADJUST_ROLES : STOCK_ADJUST_DRAFT_ROLES;
    const deniedRole = requireRole(auth, needRoles);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: invBody, request });
    if (denied) return denied;
    const access = await assertOperationalAccess(db, scopeAuth, COLLECTION, { id: path[2] });
    if ('error' in access) return access.error;
    const doc = access.doc as unknown as AdjustmentDoc;
    const tenantId = String(doc.tenantId || tenantIdForWrite(scopeAuth, invBody));
    const actor = actorFromAuth(auth);
    const now = new Date();
    const noPS = String(doc.noPenyesuaian || doc.id);

    if (action === 'submit') {
      if (doc.status !== 'DRAFT') return err('Hanya draft yang bisa diajukan', 400);
      const reasonErr = adjustmentReasonError(doc.reasonCode, doc.keterangan);
      if (reasonErr) return err(reasonErr, 400);
      const missing = (doc.items || []).filter((l) => l.qtyAktual == null);
      if (!(doc.items || []).length) return err('Tidak ada item', 400);
      if (missing.length) return err(`${missing.length} baris belum diisi qty aktual (${missing.slice(0, 3).map((l) => l.kode || l.stokId).join(', ')})`, 400);
      try {
        await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
          const res = await txDb.collection(COLLECTION).updateOne(
            casStatusFilter(doc, 'DRAFT'),
            { $set: { status: 'PENDING_APPROVAL', submittedBy: actor, submittedAt: now, updatedAt: now } },
            txOpts(session),
          );
          if (res.matchedCount === 0) throw new CasConflictError();
          await writeAuditLog(txDb, {
            tenantId, action: 'STOCK_ADJUSTMENT_SUBMITTED', entityType: COLLECTION, entityId: doc.id,
            summary: `Penyesuaian ${noPS} diajukan`, userId: actor.userId, userName: actor.userName,
            metadata: { noPenyesuaian: noPS, reasonCode: doc.reasonCode },
          }, session);
        });
      } catch (e) {
        if (isCasConflict(e)) return casConflict(e.message);
        throw e;
      }
    }

    if (action === 'reject') {
      if (doc.status !== 'PENDING_APPROVAL') return err('Hanya penyesuaian yang menunggu persetujuan yang bisa ditolak', 400);
      const reason = String(invBody.reason || '').trim();
      if (!reason) return err('Alasan penolakan wajib diisi', 400);
      try {
        await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
          const res = await txDb.collection(COLLECTION).updateOne(
            casStatusFilter(doc, 'PENDING_APPROVAL'),
            { $set: { status: 'REJECTED', rejectedBy: actor, rejectedAt: now, rejectReason: reason, updatedAt: now } },
            txOpts(session),
          );
          if (res.matchedCount === 0) throw new CasConflictError();
          await writeAuditLog(txDb, {
            tenantId, action: 'STOCK_ADJUSTMENT_REJECTED', entityType: COLLECTION, entityId: doc.id,
            summary: `Penyesuaian ${noPS} ditolak: ${reason}`, userId: actor.userId, userName: actor.userName,
            metadata: { noPenyesuaian: noPS, reason },
          }, session);
        });
      } catch (e) {
        if (isCasConflict(e)) return casConflict(e.message);
        throw e;
      }
    }

    if (action === 'cancel') {
      if (doc.status !== 'DRAFT' && doc.status !== 'PENDING_APPROVAL') return err('Hanya draft atau pengajuan yang bisa dibatalkan', 400);
      const isMaker = adjustmentMakers(doc).some((m) => m && String(m.userId || '') === actor.userId);
      const canManage = requireRole(auth, STOCK_ADJUST_ROLES) === null;
      if (!isMaker && !canManage) return err('Hanya pembuat atau Supervisor/Admin yang bisa membatalkan', 403);
      try {
        await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
          const res = await txDb.collection(COLLECTION).updateOne(
            casStatusFilter(doc, String(doc.status)),
            { $set: { status: 'CANCELLED', cancelledBy: actor, cancelledAt: now, updatedAt: now } },
            txOpts(session),
          );
          if (res.matchedCount === 0) throw new CasConflictError();
          await writeAuditLog(txDb, {
            tenantId, action: 'STOCK_ADJUSTMENT_CANCELLED', entityType: COLLECTION, entityId: doc.id,
            summary: `Penyesuaian ${noPS} dibatalkan`, userId: actor.userId, userName: actor.userName,
            metadata: { noPenyesuaian: noPS },
          }, session);
        });
      } catch (e) {
        if (isCasConflict(e)) return casConflict(e.message);
        throw e;
      }
    }

    if (action === 'approve') {
      if (doc.status !== 'PENDING_APPROVAL') return err('Hanya penyesuaian yang menunggu persetujuan yang bisa disetujui', 400);
      const selfState = selfApprovalState(auth, adjustmentMakers(doc));
      if (selfState === 'blocked') {
        return err('Pembuat, pengubah, atau pengaju penyesuaian tidak boleh menyetujui sendiri — minta Supervisor/Admin lain', 403);
      }
      const locked = await guardPosting(db, scopeAuth, invBody, now);
      if (locked) return locked;
      const costingV2 = await isTenantFeatureEnabled(db, tenantId, 'costingV2');
      try {
        await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
          const claim = await txDb.collection(COLLECTION).updateOne(
            casStatusFilter(doc, 'PENDING_APPROVAL'),
            { $set: { status: 'POSTING', postingStartedAt: now, updatedAt: now } },
            txOpts(session),
          );
          if (claim.matchedCount === 0) throw new CasConflictError();
          try {
            const postedItems = await postAdjustmentLines(txDb, session, {
              tenantId, docId: doc.id, noPS, lines: doc.items || [], mode: 'SNAPSHOT', now, actor, costingV2,
            });
            const done = await txDb.collection(COLLECTION).updateOne(
              docIdFilter(doc, { status: 'POSTING' }),
              {
                $set: {
                  status: 'POSTED',
                  items: postedItems,
                  approvedBy: actor,
                  approvedAt: now,
                  postedAt: now,
                  ...(selfState === 'master_override' ? { selfApprovedByMaster: true } : {}),
                  updatedAt: now,
                },
              },
              txOpts(session),
            );
            if (done.matchedCount === 0) throw new CasConflictError();
            await writeAuditLog(txDb, {
              tenantId, action: 'STOCK_ADJUSTMENT', entityType: COLLECTION, entityId: doc.id,
              summary: `Penyesuaian ${noPS} disetujui & diposting (${postedItems.length} item)`,
              userId: actor.userId, userName: actor.userName,
              metadata: { noPenyesuaian: noPS, reasonCode: doc.reasonCode, itemCount: postedItems.length, approval: true },
            }, session);
            if (selfState === 'master_override') {
              await writeAuditLog(txDb, {
                tenantId, action: 'STOCK_ADJUSTMENT_SELF_APPROVED', entityType: COLLECTION, entityId: doc.id,
                summary: `MASTER menyetujui penyesuaian ${noPS} yang ia buat/ajukan sendiri (darurat)`,
                userId: actor.userId, userName: actor.userName,
                metadata: { noPenyesuaian: noPS },
              }, session);
            }
          } catch (inner) {
            if (!session) {
              await txDb.collection(COLLECTION).updateOne(
                docIdFilter(doc, { status: 'POSTING' }),
                { $set: { status: 'PENDING_APPROVAL', postingStartedAt: null } },
              );
            }
            throw inner;
          }
        });
      } catch (e) {
        if (isCasConflict(e)) return casConflict(e.message);
        return err(e instanceof Error ? e.message : 'Gagal memposting penyesuaian', 400);
      }
      await invalidateDashboardSnapshot(db, tenantId);
    }

    const fresh = await db.collection(COLLECTION).findOne(docIdFilter(doc));
    return ok(clean(fresh));
  }

  return null;
}
