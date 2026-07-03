import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import { findMasterDoc, resolveOperationalScope } from '@/lib/api/tenant-master';
import { withOperationalFilter } from '@/lib/api/tenant-operational';
import { requireRole, STOCK_ADJUST_ROLES } from '@/lib/api/require-auth';
import { ledgerSaldoForProduct, reconcileProductStockFromLedger } from '@/lib/api/stock-ledger';
import type { HandlerContext } from '@/types/api/handler';
import type { InventoryBody } from './inventory-shared';

export async function handleStokKartu({
  db,
  route,
  method,
  url,
  body,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const invBody = (body || {}) as InventoryBody;

  if (route === '/stok/kartu' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const productId = url.searchParams.get('productId') || '';
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const limitParam = parseInt(url.searchParams.get('limit') || '500', 10);
    const limit = Math.min(Math.max(limitParam || 500, 50), 2000);
    let filter: Record<string, unknown> = {};
    if (productId) filter.stokId = productId;
    if (from || to) {
      const tanggal: Record<string, unknown> = {};
      if (from) tanggal.$gte = new Date(from);
      if (to) tanggal.$lte = new Date(to);
      filter.tanggal = tanggal;
    }
    filter = withOperationalFilter(scopeAuth, filter);
    const coll = db.collection('stok_kartu');
    const mutasiExpr = { $subtract: [{ $ifNull: ['$masuk', 0] }, { $ifNull: ['$keluar', 0] }] };

    const [totals] = await coll.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalMasuk: { $sum: { $ifNull: ['$masuk', 0] } },
          totalKeluar: { $sum: { $ifNull: ['$keluar', 0] } },
        },
      },
    ]).toArray();
    const totalRows = Number(totals?.count || 0);

    let saldoAwal = 0;
    if (from && productId) {
      const beforeFilter = withOperationalFilter(scopeAuth, {
        stokId: productId,
        tanggal: { $lt: new Date(from) },
      });
      const [before] = await coll.aggregate([
        { $match: beforeFilter },
        { $group: { _id: null, saldo: { $sum: mutasiExpr } } },
      ]).toArray();
      saldoAwal = Number(before?.saldo || 0);
    }

    const skip = Math.max(0, totalRows - limit);
    let saldoAwalHalaman = saldoAwal;
    if (skip > 0) {
      const [skipped] = await coll.aggregate([
        { $match: filter },
        { $sort: { tanggal: 1, _id: 1 } },
        { $limit: skip },
        { $group: { _id: null, saldo: { $sum: mutasiExpr } } },
      ]).toArray();
      saldoAwalHalaman += Number(skipped?.saldo || 0);
    }

    const list = await coll
      .find(filter)
      .project({
        id: 1, stokId: 1, lokasi: 1, tanggal: 1, noTransaksi: 1, keterangan: 1,
        sourceType: 1, masuk: 1, keluar: 1, hargaSatuan: 1, tenantId: 1,
      })
      .sort({ tanggal: 1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .toArray();
    let saldo = saldoAwalHalaman;
    const enriched = list.map((r) => {
      saldo += (r.masuk || 0) - (r.keluar || 0);
      return { ...clean(r), saldo };
    });
    let product: Record<string, unknown> | null = null;
    let ledgerSaldo: number | null = null;
    if (productId) {
      const p = await findMasterDoc(db, 'products', scopeAuth, { id: productId });
      if (p) {
        product = clean(p) as Record<string, unknown>;
        const tid = p.tenantId || scopeAuth?.tenantId || 'default';
        ledgerSaldo = await ledgerSaldoForProduct(db, tid, productId);
      }
    }
    return ok({
      rows: enriched,
      product,
      ledgerSaldo,
      saldoAwal: saldoAwalHalaman,
      totalRows,
      totalMasuk: Number(totals?.totalMasuk || 0),
      totalKeluar: Number(totals?.totalKeluar || 0),
      truncated: skip > 0,
    });
  }

  if (route === '/stok/kartu/reconcile' && method === 'POST') {
    const deniedRole = requireRole(auth, STOCK_ADJUST_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: invBody, request });
    if (denied) return denied;
    const productId = invBody.productId || '';
    if (!productId) return err('productId wajib');
    const p = await findMasterDoc(db, 'products', scopeAuth, { id: productId });
    if (!p) return err('Produk tidak ditemukan', 404);
    const tid = p.tenantId || scopeAuth?.tenantId || 'default';
    const result = await reconcileProductStockFromLedger(db, tid, p);
    if ('error' in result && result.error) return err(result.error, 400);
    const product = clean(await findMasterDoc(db, 'products', scopeAuth, { id: productId }));
    const ledgerSaldo = await ledgerSaldoForProduct(db, tid, productId);
    return ok({ product, ledgerSaldo, reconciled: result });
  }

  return null;
}
