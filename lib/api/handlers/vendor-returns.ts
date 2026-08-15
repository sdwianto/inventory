import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import { requireRole, PO_CREATE_ROLES } from '@/lib/api/require-auth';
import { resolveOperationalScope, tenantIdForWrite, withTenantFilter } from '@/lib/api/tenant-master';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { guardPosting } from '@/lib/api/period-lock';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { parseCursorPageParams, applyDescDateIdCursor, cursorPageResponse } from '@/lib/api/cursor-page';
import { storeBase64Image } from '@/lib/api/media-storage';
import { isValidWarehouseKode } from '@/lib/api/warehouses';
import { resolveLineQtyBase } from '@/lib/uom/resolve-line-qty';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { buildVendorReturnLinesFromHutang } from '@/lib/api/vendor-return-map';
import { assertReturnQtyWithinMax, buildReturableLines } from '@/lib/api/vendor-return-returable';
import { postVendorReturn, retryVendorReturnCn } from '@/lib/api/vendor-return-post';
import { VENDOR_RETURNS_COLLECTION, vendorReturnLineKey, type VendorReturnDoc, type VendorReturnLine } from '@/types/vendor-return';
import type { HandlerContext } from '@/types/api/handler';
import type { JsonObject } from '@/types/json';

const MAX_PHOTOS = 5;
const RTV_ROLES = PO_CREATE_ROLES;

interface RtvBody extends Record<string, unknown> {
  hutangId?: string;
  noInvoice?: string;
  vendorTenantId?: string;
  reason?: string;
  photos?: unknown[];
  items?: unknown[];
  userName?: string;
}

async function persistPhotos(tenantId: string, raw: unknown[]): Promise<string[] | { error: string }> {
  if (raw.length > MAX_PHOTOS) return { error: `Maksimal ${MAX_PHOTOS} foto untuk retur vendor` };
  const urls: string[] = [];
  for (const item of raw) {
    const s = String(item || '').trim();
    if (!s) continue;
    if (s.startsWith('/api/media/') || s.startsWith('http://') || s.startsWith('https://')) {
      urls.push(s);
      continue;
    }
    const stored = await storeBase64Image(tenantId, s, { prefix: 'rtv', maxBytes: 768_000 });
    if ('error' in stored) return { error: `Foto: ${stored.error}` };
    urls.push(stored.url);
  }
  return urls;
}

function totalsFromItems(items: VendorReturnLine[]) {
  const subTotal = items.reduce((s, it) => s + (parseInt(String(it.jumlah || 0), 10) || 0), 0);
  return { subTotal, total: subTotal };
}

async function loadPostedReturns(
  db: HandlerContext['db'],
  tenantId: string,
  noInvoice: string,
  hutangId?: string | null,
) {
  const filter: Record<string, unknown> = {
    ...tenantIdMatchFilter(tenantId),
    status: { $in: ['POSTED', 'POSTING'] },
    $or: [
      { noInvoice },
      ...(hutangId ? [{ hutangId }] : []),
    ],
  };
  return db.collection(VENDOR_RETURNS_COLLECTION).find(filter).toArray();
}

async function loadHutangForReturn(
  db: HandlerContext['db'],
  tenantId: string,
  body: RtvBody,
) {
  const hutangId = String(body.hutangId || '').trim();
  const noInvoice = String(body.noInvoice || '').trim();
  const vendorTenantId = String(body.vendorTenantId || '').trim();
  const base = tenantIdMatchFilter(tenantId);
  if (hutangId) {
    return db.collection('hutang').findOne({ ...base, id: hutangId });
  }
  if (!noInvoice) return null;
  const q: Record<string, unknown> = { ...base, noInvoice };
  if (vendorTenantId) q.vendorTenantId = vendorTenantId;
  return db.collection('hutang').findOne(q);
}

async function hydrateDraftItems(
  db: HandlerContext['db'],
  tenantId: string,
  rawItems: unknown[],
  existing?: VendorReturnLine[],
): Promise<VendorReturnLine[] | { error: string }> {
  const byKey = new Map((existing || []).map((it) => [vendorReturnLineKey(it), it]));
  const items: VendorReturnLine[] = [];
  const uomsCache = new Map<string, import('@/lib/uom/types').ProductUom[]>();
  for (const raw of rawItems) {
    const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const key = vendorReturnLineKey({
      invoiceLineId: row.invoiceLineId ? String(row.invoiceLineId) : null,
      localStokId: String(row.localStokId || ''),
      uomId: row.uomId ? String(row.uomId) : undefined,
      satuan: row.satuan ? String(row.satuan) : undefined,
    });
    const prev = byKey.get(key);
    const localStokId = String(row.localStokId || prev?.localStokId || '');
    const qty = parseFloat(String(row.qty ?? prev?.qty ?? 0)) || 0;
    if (!localStokId || qty <= 0) continue;
    const gudang = String(row.gudangKode || prev?.gudangKode || 'GKERING');
    if (!isValidWarehouseKode(gudang)) return { error: `Gudang tidak valid: ${gudang}` };
    const resolved = await resolveLineQtyBase(db, tenantId, localStokId, {
      qty,
      uomId: String(row.uomId || prev?.uomId || ''),
      satuan: String(row.satuan || prev?.satuan || ''),
    }, uomsCache);
    if ('error' in resolved) return { error: resolved.error };
    const harga = parseInt(String(row.harga ?? prev?.harga ?? 0), 10) || 0;
    items.push({
      lineId: String(row.lineId || prev?.lineId || key),
      invoiceLineId: String(row.invoiceLineId || prev?.invoiceLineId || ''),
      grnLineId: (row.grnLineId || prev?.grnLineId) ? String(row.grnLineId || prev?.grnLineId) : null,
      localStokId,
      localKode: String(row.localKode || prev?.localKode || ''),
      localNama: String(row.localNama || prev?.localNama || ''),
      vendorKode: String(row.vendorKode || prev?.vendorKode || ''),
      satuan: resolved.satuan || String(row.satuan || prev?.satuan || ''),
      uomId: resolved.uomId || String(row.uomId || prev?.uomId || ''),
      vendorUomId: String(row.vendorUomId || prev?.vendorUomId || ''),
      factorToBase: resolved.factorToBase,
      qty,
      qtyBase: resolved.qtyBase,
      harga,
      jumlah: Math.round(qty * harga),
      gudangKode: gudang,
      lotNo: row.lotNo != null ? String(row.lotNo) : prev?.lotNo,
      maxQty: parseFloat(String(row.maxQty ?? prev?.maxQty ?? qty)) || qty,
    });
  }
  if (!items.length) return { error: 'Minimal satu baris retur dengan qty > 0' };
  return items;
}

export async function handleVendorReturns({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const rtvBody = (body || {}) as RtvBody;

  if (route === '/vendor-returns' && method === 'GET') {
    const deniedRole = requireRole(auth, RTV_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;

    const status = url.searchParams.get('status');
    const q = String(url.searchParams.get('q') || '').trim();
    let filter: Record<string, unknown> = status ? { status } : {};
    if (q) {
      filter = {
        ...filter,
        $or: [
          { noReturn: { $regex: q, $options: 'i' } },
          { noInvoice: { $regex: q, $options: 'i' } },
          { noGRN: { $regex: q, $options: 'i' } },
          { noCN: { $regex: q, $options: 'i' } },
        ],
      };
    }
    filter = withTenantFilter(scopeAuth, filter);
    const { pageMode, limit, cursor } = parseCursorPageParams(url.searchParams, { defaultLimit: 100, maxLimit: 300 });
    const listFilter = applyDescDateIdCursor(filter, cursor, 'createdAt');
    const list = await db.collection(VENDOR_RETURNS_COLLECTION)
      .find(listFilter)
      .sort({ createdAt: -1, id: -1 })
      .limit(limit)
      .toArray();
    const cleaned = list.map((row) => clean(row as JsonObject));
    if (pageMode) {
      const last = list[list.length - 1] as Record<string, unknown> | undefined;
      return ok(cursorPageResponse(cleaned, limit, 'createdAt', last));
    }
    return ok(cleaned);
  }

  if (route === '/vendor-returns/eligible-invoices' && method === 'GET') {
    const deniedRole = requireRole(auth, RTV_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!tenantId) return err('Scope tidak valid', 400);

    const hutangList = await db.collection('hutang')
      .find(withTenantFilter(scopeAuth, {
        referenceType: 'VENDOR_INVOICE',
        approvalStatus: { $nin: ['REJECTED'] },
      }))
      .sort({ tanggal: -1, id: -1 })
      .limit(80)
      .toArray();

    const invoices = hutangList.map((h) => String(h.noInvoice || '')).filter(Boolean);
    const posted = invoices.length
      ? await db.collection(VENDOR_RETURNS_COLLECTION).find({
        ...tenantIdMatchFilter(tenantId),
        noInvoice: { $in: invoices },
        status: { $in: ['POSTED', 'POSTING'] },
      }).toArray()
      : [];
    const postedByInvoice = new Map<string, typeof posted>();
    for (const p of posted) {
      const k = String(p.noInvoice || '');
      const arr = postedByInvoice.get(k) || [];
      arr.push(p);
      postedByInvoice.set(k, arr);
    }

    const rows = [];
    for (const h of hutangList) {
      const returable = buildReturableLines(h, postedByInvoice.get(String(h.noInvoice || '')) || []);
      const maxQty = returable.reduce((s, r) => s + (r.maxQty || 0), 0);
      if (maxQty <= 0) continue;
      rows.push({
        hutangId: h.id,
        noInvoice: h.noInvoice,
        noHutang: h.noHutang,
        vendorTenantId: h.vendorTenantId,
        supplierName: h.supplierName,
        noGRN: h.noGRN || h.noDO,
        noDO: h.noDO,
        noPO: h.noPO,
        noSO: h.noSO,
        total: h.total,
        sisa: h.sisa,
        approvalStatus: h.approvalStatus,
        returableLines: returable.filter((r) => r.maxQty > 0).length,
        maxQty,
      });
    }
    return ok(rows);
  }

  if (path[0] === 'vendor-returns' && path[1] && path[2] === 'post' && method === 'POST') {
    const deniedRole = requireRole(auth, RTV_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, body: rtvBody, request });
    if (denied) return denied;
    const locked = await guardPosting(db, scopeAuth, rtvBody);
    if (locked) return locked;
    if (!tenantId) return err('Scope tidak valid', 400);

    const doc = await db.collection(VENDOR_RETURNS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as VendorReturnDoc | null;
    if (!doc) return err('Tidak ditemukan', 404);
    if (doc.status !== 'DRAFT') return err('Hanya DRAFT yang bisa diposting', 400);
    const reason = String(rtvBody.reason || doc.reason || '').trim();
    if (!reason) return err('Alasan retur wajib sebelum post', 400);

    let items = doc.items || [];
    if (Array.isArray(rtvBody.items)) {
      const hydrated = await hydrateDraftItems(db, tenantId, rtvBody.items, items);
      if ('error' in hydrated) return err(hydrated.error, 400);
      items = hydrated;
    }
    if (!items.length) return err('Minimal satu baris retur', 400);

    const hutang = await db.collection('hutang').findOne({
      ...tenantIdMatchFilter(tenantId),
      ...(doc.hutangId ? { id: doc.hutangId } : { noInvoice: doc.noInvoice }),
    });
    if (!hutang) return err('Tagihan terkait tidak ditemukan', 400);
    const posted = await loadPostedReturns(db, tenantId, doc.noInvoice, doc.hutangId);
    const returable = buildReturableLines(hutang, posted, { excludeReturnId: doc.id });
    const qtyErr = assertReturnQtyWithinMax(items, returable);
    if (qtyErr) return err(qtyErr, 400);

    if (Array.isArray(rtvBody.photos)) {
      const photos = await persistPhotos(tenantId, rtvBody.photos);
      if ('error' in photos) return err(photos.error, 400);
      rtvBody.photos = photos;
    }

    const { subTotal, total } = totalsFromItems(items);
    await db.collection(VENDOR_RETURNS_COLLECTION).updateOne(
      { id: doc.id, status: 'DRAFT' },
      {
        $set: {
          items,
          reason,
          subTotal,
          total,
          updatedAt: new Date(),
          ...(Array.isArray(rtvBody.photos) ? { photos: rtvBody.photos } : {}),
        },
      },
    );
    const fresh = await db.collection(VENDOR_RETURNS_COLLECTION).findOne({ id: doc.id }) as VendorReturnDoc | null;
    if (!fresh) return err('Tidak ditemukan', 404);

    const result = await postVendorReturn(db, {
      doc: fresh,
      tenantId,
      body: {
        ...rtvBody,
        userName: rtvBody.userName || auth?.name,
        userId: auth?.userId,
        photos: rtvBody.photos,
      },
    });
    if (result.error) return err(String(result.error), 400);
    return ok(clean(result as JsonObject));
  }

  if (path[0] === 'vendor-returns' && path[1] && path[2] === 'retry-cn' && method === 'POST') {
    const deniedRole = requireRole(auth, RTV_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, body: rtvBody, request });
    if (denied) return denied;
    if (!tenantId) return err('Scope tidak valid', 400);
    const doc = await db.collection(VENDOR_RETURNS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as VendorReturnDoc | null;
    if (!doc) return err('Tidak ditemukan', 404);
    const result = await retryVendorReturnCn(db, { doc, tenantId });
    if (result.error) return err(String(result.error), 400);
    return ok(clean(result as JsonObject));
  }

  if (path[0] === 'vendor-returns' && path[1] && !path[2] && method === 'GET') {
    const deniedRole = requireRole(auth, RTV_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const doc = await db.collection(VENDOR_RETURNS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as VendorReturnDoc | null;
    if (!doc) return err('Tidak ditemukan', 404);
    let returable: ReturnType<typeof buildReturableLines> = [];
    if (doc.status === 'DRAFT' && tenantId) {
      const hutang = await db.collection('hutang').findOne({
        ...tenantIdMatchFilter(tenantId),
        ...(doc.hutangId ? { id: doc.hutangId } : { noInvoice: doc.noInvoice }),
      });
      if (hutang) {
        const posted = await loadPostedReturns(db, tenantId, doc.noInvoice, doc.hutangId);
        returable = buildReturableLines(hutang, posted, { excludeReturnId: doc.id });
      }
    }
    return ok(clean({ ...doc, returable } as JsonObject));
  }

  if (route === '/vendor-returns' && method === 'POST') {
    const deniedRole = requireRole(auth, RTV_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, tenantId } = resolveOperationalScope(auth, { url, body: rtvBody, request });
    if (denied) return denied;
    if (!tenantId) return err('Scope tidak valid', 400);

    const hutang = await loadHutangForReturn(db, tenantId, rtvBody);
    if (!hutang) return err('Tagihan tidak ditemukan. Isi hutangId atau noInvoice.', 400);
    const approval = String(hutang.approvalStatus || hutang.status || '');
    if (approval === 'REJECTED') return err('Tagihan ditolak tidak bisa diretur', 400);

    const posted = await loadPostedReturns(db, tenantId, String(hutang.noInvoice || ''), String(hutang.id || ''));
    const mapped = await buildVendorReturnLinesFromHutang(db, tenantId, hutang, posted);
    if (!mapped.items.length) {
      const why = mapped.skipped[0] || 'Tidak ada qty returable pada tagihan ini';
      return err(why, 400);
    }

    if (Array.isArray(rtvBody.items) && rtvBody.items.length) {
      const hydrated = await hydrateDraftItems(db, tenantId, rtvBody.items, mapped.items);
      if ('error' in hydrated) return err(hydrated.error, 400);
      mapped.items = hydrated;
    }

    const returable = buildReturableLines(hutang, posted);
    const qtyErr = assertReturnQtyWithinMax(mapped.items, returable);
    if (qtyErr) return err(qtyErr, 400);

    let photos: string[] = [];
    if (Array.isArray(rtvBody.photos)) {
      const stored = await persistPhotos(tenantId, rtvBody.photos);
      if ('error' in stored) return err(stored.error, 400);
      photos = stored;
    }

    const { subTotal, total } = totalsFromItems(mapped.items);
    const now = new Date();
    const writeTid = tenantIdForWrite(auth, rtvBody) || tenantId;
    const doc = stampTenantId(writeTid, {
      id: uuidv4(),
      tenantId: writeTid,
      noReturn: await nextDocNumber(db, writeTid, 'RTV', 'RTV'),
      status: 'DRAFT',
      vendorTenantId: String(hutang.vendorTenantId || rtvBody.vendorTenantId || ''),
      hutangId: String(hutang.id || ''),
      vendorInvoiceId: String(hutang.vendorInvoiceId || hutang.referenceId || ''),
      noInvoice: String(hutang.noInvoice || ''),
      noGRN: hutang.noGRN ? String(hutang.noGRN) : null,
      grnId: hutang.grnId ? String(hutang.grnId) : null,
      noDO: hutang.noDO ? String(hutang.noDO) : null,
      noPO: hutang.noPO ? String(hutang.noPO) : null,
      noSO: hutang.noSO ? String(hutang.noSO) : null,
      reason: String(rtvBody.reason || '').trim(),
      photos,
      items: mapped.items,
      subTotal,
      total,
      cnSyncStatus: 'NONE',
      createdAt: now,
      updatedAt: now,
      createdBy: { userId: auth?.userId, userName: auth?.name || rtvBody.userName },
    }) as VendorReturnDoc;

    await db.collection(VENDOR_RETURNS_COLLECTION).insertOne(doc);
    return ok(clean({
      ...doc,
      skipped: mapped.skipped,
    } as JsonObject), 201);
  }

  if (path[0] === 'vendor-returns' && path[1] && !path[2] && method === 'PATCH') {
    const deniedRole = requireRole(auth, RTV_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, body: rtvBody, request });
    if (denied) return denied;
    if (!tenantId) return err('Scope tidak valid', 400);
    const doc = await db.collection(VENDOR_RETURNS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as VendorReturnDoc | null;
    if (!doc) return err('Tidak ditemukan', 404);
    if (doc.status !== 'DRAFT') return err('Hanya DRAFT yang bisa diubah', 400);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (rtvBody.reason !== undefined) patch.reason = String(rtvBody.reason || '').trim();
    if (Array.isArray(rtvBody.photos)) {
      const photos = await persistPhotos(tenantId, rtvBody.photos);
      if ('error' in photos) return err(photos.error, 400);
      patch.photos = photos;
    }
    if (Array.isArray(rtvBody.items)) {
      const hydrated = await hydrateDraftItems(db, tenantId, rtvBody.items, doc.items);
      if ('error' in hydrated) return err(hydrated.error, 400);
      const hutang = await db.collection('hutang').findOne({
        ...tenantIdMatchFilter(tenantId),
        ...(doc.hutangId ? { id: doc.hutangId } : { noInvoice: doc.noInvoice }),
      });
      if (hutang) {
        const posted = await loadPostedReturns(db, tenantId, doc.noInvoice, doc.hutangId);
        const returable = buildReturableLines(hutang, posted, { excludeReturnId: doc.id });
        const qtyErr = assertReturnQtyWithinMax(hydrated, returable);
        if (qtyErr) return err(qtyErr, 400);
      }
      const { subTotal, total } = totalsFromItems(hydrated);
      patch.items = hydrated;
      patch.subTotal = subTotal;
      patch.total = total;
    }
    await db.collection(VENDOR_RETURNS_COLLECTION).updateOne({ id: doc.id }, { $set: patch });
    const fresh = await db.collection(VENDOR_RETURNS_COLLECTION).findOne({ id: doc.id });
    return ok(clean(fresh as JsonObject));
  }

  if (path[0] === 'vendor-returns' && path[1] && !path[2] && method === 'DELETE') {
    const deniedRole = requireRole(auth, RTV_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!tenantId) return err('Scope tidak valid', 400);
    const doc = await db.collection(VENDOR_RETURNS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as VendorReturnDoc | null;
    if (!doc) return err('Tidak ditemukan', 404);
    if (doc.status !== 'DRAFT') return err('Hanya DRAFT yang bisa dihapus', 400);
    await db.collection(VENDOR_RETURNS_COLLECTION).deleteOne({ id: doc.id, status: 'DRAFT' });
    return ok({ deleted: true, id: doc.id });
  }

  return null;
}
