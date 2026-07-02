import type { Db } from 'mongodb';
// Inventory handler: Kartu Stok, Penyesuaian, Produksi, Lokasi (master), Transfer Stok.

import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  withTenantFilter,
  tenantIdForWrite,
  findMasterDoc,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import {
  withOperationalFilter,
  stampTenantId,
  updateProductStockScoped,
} from '@/lib/api/tenant-operational';
import { assertOperationalAccess, assertMasterAccess } from '@/lib/api/tenant-validate';
import { requireRole, STOCK_ADJUST_ROLES } from '@/lib/api/require-auth';
import { bulkDeleteMaster } from '@/lib/api/bulk-delete-master';
import { guardPosting } from '@/lib/api/period-lock';
import {
  parseLokasiKode,
  setQtyStokLokasi,
  syncProductStokFromLokasi,
  ensureStokLokasiRow,
  transferStokBetweenLokasi,
  getStokByWarehouseBatch,
} from '@/lib/api/stok-lokasi';
import { warehouseLabel, WAREHOUSE_CODES, normalizeWarehouseKode, ensureWarehousesForTenant, isValidWarehouseKode } from '@/lib/api/warehouses';
import { resolveProductGudangKode, purgeOtherWarehouseRows, assertProductWarehouse } from '@/lib/api/product-warehouse';
import { ledgerSaldoForProduct, reconcileProductStockFromLedger } from '@/lib/api/stock-ledger';
import { writeAuditLog } from '@/lib/api/audit-log';
import type { HandlerContext } from '@/types/api/handler';
import type { AuthContext } from '@/types/auth';

interface InventoryBody extends Record<string, unknown> {
  productId?: string;
  items?: Array<Record<string, unknown>>;
  keterangan?: string;
  userId?: string;
  userName?: string;
  bahan?: Array<Record<string, unknown>>;
  hasil?: Array<Record<string, unknown>>;
  biayaProduksi?: number | string;
  catatan?: string;
  lokasiAsal?: string;
  lokasiTujuan?: string;
  lokasiAsalNama?: string;
  lokasiTujuanNama?: string;
  ids?: unknown[];
  aktif?: boolean;
}

interface ProductRow extends Record<string, unknown> {
  id: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  stok?: number;
  hargaBeli?: number;
  tenantId?: string;
  gudangKode?: string;
}

interface TrendBucket {
  period: string;
  label: string;
  masukQty: number;
  keluarQty: number;
  netQty: number;
  masukNilai: number;
  keluarNilai: number;
  netNilai: number;
  keringMasukQty: number;
  keringKeluarQty: number;
  basahMasukQty: number;
  basahKeluarQty: number;
  keringMasukNilai: number;
  keringKeluarNilai: number;
  basahMasukNilai: number;
  basahKeluarNilai: number;
  transaksi: number;
  keringNetQty?: number;
  basahNetQty?: number;
}

interface TrendPeriod extends TrendBucket {
  saldoQtyKumulatif: number;
  saldoNilaiKumulatif: number;
  keringSaldoKumulatif: number;
  basahSaldoKumulatif: number;
}

interface ProductionLineItem {
  stokId: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  qty: number;
  hargaBeli: number;
}

function periodKey(date: Date | string, granularity: string): string {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  if (granularity === 'day') return `${y}-${m}-${day}`;
  return `${y}-${m}`;
}

function emptyTrendBucket(key: string, label: string): TrendBucket {
  return {
    period: key,
    label,
    masukQty: 0,
    keluarQty: 0,
    netQty: 0,
    masukNilai: 0,
    keluarNilai: 0,
    netNilai: 0,
    keringMasukQty: 0,
    keringKeluarQty: 0,
    basahMasukQty: 0,
    basahKeluarQty: 0,
    keringMasukNilai: 0,
    keringKeluarNilai: 0,
    basahMasukNilai: 0,
    basahKeluarNilai: 0,
    transaksi: 0,
  };
}

async function aggregateOpeningBefore(db: HandlerContext['db'], tid: string, since: Date) {
  const rows = await db.collection('stok_kartu').aggregate([
    { $match: { tenantId: tid, tanggal: { $lt: since } } },
    {
      $group: {
        _id: { $ifNull: ['$lokasiKode', '$lokasi'] },
        masuk: { $sum: { $ifNull: ['$masuk', 0] } },
        keluar: { $sum: { $ifNull: ['$keluar', 0] } },
      },
    },
  ]).toArray();

  let kering = 0;
  let basah = 0;
  for (const r of rows) {
    const net = (parseFloat(r.masuk) || 0) - (parseFloat(r.keluar) || 0);
    const lok = normalizeWarehouseKode(r._id || '');
    if (lok === 'GKERING') kering += net;
    else if (lok === 'GBASAH') basah += net;
  }
  return { kering, basah, total: kering + basah };
}

async function buildStockTrend(
  db: HandlerContext['db'],
  tenantId: string | null | undefined,
  { months = 6, granularity = 'day' }: { months?: number; granularity?: string } = {},
) {
  const tid = tenantId || 'default';
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  since.setHours(0, 0, 0, 0);
  const until = new Date();
  until.setHours(23, 59, 59, 999);

  const opening = await aggregateOpeningBefore(db, tid, since);

  const dateFormat = granularity === 'day' ? '%Y-%m-%d' : '%Y-%m';
  const aggRows = await db.collection('stok_kartu').aggregate([
    { $match: { tenantId: tid, tanggal: { $gte: since, $lte: until } } },
    {
      $addFields: {
        wh: {
          $let: {
            vars: { loc: { $toUpper: { $ifNull: ['$lokasiKode', '$lokasi'] } } },
            in: {
              $switch: {
                branches: [
                  { case: { $regexMatch: { input: '$$loc', regex: 'GKERING' } }, then: 'GKERING' },
                  { case: { $regexMatch: { input: '$$loc', regex: 'GBASAH' } }, then: 'GBASAH' },
                ],
                default: 'OTHER',
              },
            },
          },
        },
        masukN: { $toDouble: { $ifNull: ['$masuk', 0] } },
        keluarN: { $toDouble: { $ifNull: ['$keluar', 0] } },
        hargaN: { $toDouble: { $ifNull: ['$hargaSatuan', 0] } },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: dateFormat, date: '$tanggal' } },
        masukQty: { $sum: '$masukN' },
        keluarQty: { $sum: '$keluarN' },
        masukNilai: { $sum: { $multiply: ['$masukN', '$hargaN'] } },
        keluarNilai: { $sum: { $multiply: ['$keluarN', '$hargaN'] } },
        transaksi: { $sum: 1 },
        keringMasukQty: { $sum: { $cond: [{ $eq: ['$wh', 'GKERING'] }, '$masukN', 0] } },
        keringKeluarQty: { $sum: { $cond: [{ $eq: ['$wh', 'GKERING'] }, '$keluarN', 0] } },
        basahMasukQty: { $sum: { $cond: [{ $eq: ['$wh', 'GBASAH'] }, '$masukN', 0] } },
        basahKeluarQty: { $sum: { $cond: [{ $eq: ['$wh', 'GBASAH'] }, '$keluarN', 0] } },
        keringMasukNilai: { $sum: { $cond: [{ $eq: ['$wh', 'GKERING'] }, { $multiply: ['$masukN', '$hargaN'] }, 0] } },
        keringKeluarNilai: { $sum: { $cond: [{ $eq: ['$wh', 'GKERING'] }, { $multiply: ['$keluarN', '$hargaN'] }, 0] } },
        basahMasukNilai: { $sum: { $cond: [{ $eq: ['$wh', 'GBASAH'] }, { $multiply: ['$masukN', '$hargaN'] }, 0] } },
        basahKeluarNilai: { $sum: { $cond: [{ $eq: ['$wh', 'GBASAH'] }, { $multiply: ['$keluarN', '$hargaN'] }, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]).toArray();

  const buckets = new Map<string, TrendBucket>();
  for (const row of aggRows) {
    const key = String(row._id);
    const d = new Date(`${key}${granularity === 'day' ? '' : '-01'}`);
    const label = granularity === 'day'
      ? d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' })
      : d.toLocaleDateString('id-ID', { month: 'short', year: 'numeric' });
    buckets.set(key, {
      period: key,
      label,
      masukQty: row.masukQty || 0,
      keluarQty: row.keluarQty || 0,
      netQty: 0,
      masukNilai: row.masukNilai || 0,
      keluarNilai: row.keluarNilai || 0,
      netNilai: 0,
      keringMasukQty: row.keringMasukQty || 0,
      keringKeluarQty: row.keringKeluarQty || 0,
      basahMasukQty: row.basahMasukQty || 0,
      basahKeluarQty: row.basahKeluarQty || 0,
      keringMasukNilai: row.keringMasukNilai || 0,
      keringKeluarNilai: row.keringKeluarNilai || 0,
      basahMasukNilai: row.basahMasukNilai || 0,
      basahKeluarNilai: row.basahKeluarNilai || 0,
      transaksi: row.transaksi || 0,
    });
  }

  let runningQty = opening.total;
  let runningNilai = 0;
  let runningKering = opening.kering;
  let runningBasah = opening.basah;
  const periods: TrendPeriod[] = [];

  const cursor = new Date(since);
  while (cursor <= until) {
    const key = periodKey(cursor, granularity);
    const label = granularity === 'day'
      ? cursor.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' })
      : cursor.toLocaleDateString('id-ID', { month: 'short', year: 'numeric' });

    const row = buckets.get(key) || emptyTrendBucket(key, label);
    row.netQty = row.masukQty - row.keluarQty;
    row.netNilai = row.masukNilai - row.keluarNilai;
    row.keringNetQty = row.keringMasukQty - row.keringKeluarQty;
    row.basahNetQty = row.basahMasukQty - row.basahKeluarQty;

    runningQty += row.netQty;
    runningNilai += row.netNilai;
    runningKering += row.keringNetQty;
    runningBasah += row.basahNetQty;

    periods.push({
      ...row,
      label,
      saldoQtyKumulatif: runningQty,
      saldoNilaiKumulatif: runningNilai,
      keringSaldoKumulatif: runningKering,
      basahSaldoKumulatif: runningBasah,
    });

    if (granularity === 'day') {
      cursor.setDate(cursor.getDate() + 1);
    } else {
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }

  const totals = periods.reduce((acc, p) => ({
    masukQty: acc.masukQty + p.masukQty,
    keluarQty: acc.keluarQty + p.keluarQty,
    netQty: acc.netQty + p.netQty,
    masukNilai: acc.masukNilai + p.masukNilai,
    keluarNilai: acc.keluarNilai + p.keluarNilai,
    netNilai: acc.netNilai + p.netNilai,
    keringMasukQty: acc.keringMasukQty + p.keringMasukQty,
    keringKeluarQty: acc.keringKeluarQty + p.keringKeluarQty,
    basahMasukQty: acc.basahMasukQty + p.basahMasukQty,
    basahKeluarQty: acc.basahKeluarQty + p.basahKeluarQty,
    transaksi: acc.transaksi + p.transaksi,
  }), {
    masukQty: 0, keluarQty: 0, netQty: 0,
    masukNilai: 0, keluarNilai: 0, netNilai: 0,
    keringMasukQty: 0, keringKeluarQty: 0, basahMasukQty: 0, basahKeluarQty: 0,
    transaksi: 0,
  });

  return {
    periods,
    totals,
    opening,
    since: since.toISOString(),
    until: until.toISOString(),
    granularity,
  };
}

function asProductRow(doc: Record<string, unknown> | null | undefined): ProductRow {
  return doc as ProductRow;
}

function itemStokId(it: Record<string, unknown>): string {
  return String(it.stokId || '');
}

export async function handleInventory({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const invBody = (body || {}) as InventoryBody;
  // ---------- SALDO PER GUDANG ----------
  if (route === '/stok/saldo' && method === 'GET') {
    const { denied, scopeAuth, tenantId: tid } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!tid) return err('Scope tidak valid', 400);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    let filter = withTenantFilter(scopeAuth, { aktif: { $ne: false } });
    if (q) {
      filter = {
        ...filter,
        $or: [
          { nama: { $regex: q, $options: 'i' } },
          { kode: { $regex: q, $options: 'i' } },
        ],
      };
    }
    const gudangFilter = url.searchParams.get('gudang');
    if (gudangFilter && isValidWarehouseKode(gudangFilter)) {
      filter = { ...filter, gudangKode: normalizeWarehouseKode(gudangFilter) };
    }
    const products = await db.collection('products')
      .find(filter)
      .project({ id: 1, kode: 1, nama: 1, satuan: 1, stok: 1, hargaBeli: 1, tenantId: 1, gudangKode: 1 })
      .sort({ gudangKode: 1, nama: 1 })
      .limit(500)
      .toArray();
    const trendMonths = Math.min(24, Math.max(1, parseInt(url.searchParams.get('trendMonths') || '6', 10)));
    const stokMap = await getStokByWarehouseBatch(db, tid, products.map((p) => p.id));
    let summaryQtyKering = 0;
    let summaryQtyBasah = 0;
    let summaryNilaiKering = 0;
    let summaryNilaiBasah = 0;
    let skuAktif = 0;

    const rows = products.map((p) => {
      const gudangKode = resolveProductGudangKode(p);
      const byWh = stokMap.get(p.id) || Object.fromEntries(WAREHOUSE_CODES.map((k) => [k, 0]));
      const stokQty = byWh[gudangKode] || parseFloat(p.stok) || 0;
      const hargaBeli = parseInt(p.hargaBeli || 0, 10);
      const nilaiStok = Math.round(stokQty * hargaBeli);
      const qtyKering = gudangKode === 'GKERING' ? stokQty : 0;
      const qtyBasah = gudangKode === 'GBASAH' ? stokQty : 0;
      const nilaiKering = gudangKode === 'GKERING' ? nilaiStok : 0;
      const nilaiBasah = gudangKode === 'GBASAH' ? nilaiStok : 0;

      if (stokQty > 0) skuAktif += 1;
      summaryQtyKering += qtyKering;
      summaryQtyBasah += qtyBasah;
      summaryNilaiKering += nilaiKering;
      summaryNilaiBasah += nilaiBasah;

      return clean({
        ...p,
        gudangKode,
        gudangNama: warehouseLabel(gudangKode),
        hargaBeli,
        stokQty,
        nilaiStok,
        stokGudangKering: qtyKering,
        stokGudangBasah: qtyBasah,
        stokByWarehouse: { [gudangKode]: stokQty },
        stokTotal: stokQty,
        nilaiGudangKering: nilaiKering,
        nilaiGudangBasah: nilaiBasah,
        nilaiTotal: nilaiStok,
      });
    });

    const trend = await buildStockTrend(db, tid, { months: trendMonths, granularity: 'day' });

    return ok({
      warehouses: WAREHOUSE_CODES.map((k) => ({ kode: k, nama: warehouseLabel(k) })),
      summary: {
        qtyKering: summaryQtyKering,
        qtyBasah: summaryQtyBasah,
        qtyTotal: summaryQtyKering + summaryQtyBasah,
        nilaiKering: summaryNilaiKering,
        nilaiBasah: summaryNilaiBasah,
        nilaiTotal: summaryNilaiKering + summaryNilaiBasah,
        skuAktif,
        skuTotal: rows.length,
      },
      trend,
      rows,
    });
  }

  // ---------- KARTU STOK ----------
  if (route === '/stok/kartu' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const productId = url.searchParams.get('productId') || '';
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    let filter: Record<string, unknown> = {};
    if (productId) filter.stokId = productId;
    if (from || to) {
      const tanggal: Record<string, unknown> = {};
      if (from) tanggal.$gte = new Date(from);
      if (to) tanggal.$lte = new Date(to);
      filter.tanggal = tanggal;
    }
    filter = withOperationalFilter(scopeAuth, filter);
    const list = await db.collection('stok_kartu')
      .find(filter)
      .project({
        id: 1, stokId: 1, lokasi: 1, tanggal: 1, noTransaksi: 1, keterangan: 1,
        sourceType: 1, masuk: 1, keluar: 1, hargaSatuan: 1, tenantId: 1,
      })
      .sort({ tanggal: 1, _id: 1 })
      .limit(2000)
      .toArray();
    let saldo = 0;
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
    return ok({ rows: enriched, product, ledgerSaldo });
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

  // ---------- PENYESUAIAN ----------
  if (route === '/stok/penyesuaian' && method === 'GET') {
    const deniedRole = requireRole(auth, STOCK_ADJUST_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const list = await db.collection('penyesuaian_stok')
      .find(withOperationalFilter(scopeAuth, {}))
      .sort({ tanggal: -1 })
      .limit(200)
      .toArray();
    return ok(list.map(clean));
  }
  if (route === '/stok/penyesuaian' && method === 'POST') {
    const deniedRole = requireRole(auth, STOCK_ADJUST_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: invBody, request });
    if (denied) return denied;
    const locked = await guardPosting(db, scopeAuth, invBody);
    if (locked) return locked;
    const items = invBody.items || [];
    if (items.length === 0) return err('Tidak ada item');
    const tenantId = tenantIdForWrite(scopeAuth, invBody);
    const now = new Date();
    const noPS = `PS${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`;
    const doc = stampTenantId(tenantId, {
      id: uuidv4(),
      noPenyesuaian: noPS,
      tanggal: now,
      lokasi: '',
      keterangan: invBody.keterangan || '',
      userId: invBody.userId || '',
      userName: invBody.userName || '',
      items: [],
      createdAt: now,
    });
    for (const it of items) {
      const stokId = itemStokId(it);
      const prodRaw = await findMasterDoc(db, 'products', scopeAuth, { id: stokId });
      if (!prodRaw) return err(`Produk ${it.kode || stokId} tidak ditemukan`, 404);
      const prod = asProductRow(prodRaw);
      const lokasiKode = resolveProductGudangKode(prod);
      const lokasiLabel = `${lokasiKode} - ${warehouseLabel(lokasiKode)}`;
      if (!doc.lokasi) doc.lokasi = lokasiLabel;
      else if (doc.lokasi !== lokasiLabel && doc.lokasi !== 'Multi gudang') doc.lokasi = 'Multi gudang';

      await ensureStokLokasiRow(db, tenantId, prod.id, lokasiKode);
      const row = await db.collection('stok_lokasi').findOne({
        tenantId, stokId: prod.id, lokasiKode,
      });
      const qtySistem = row ? (parseFloat(row.qty) || 0) : 0;
      const qtyAktual = parseFloat(String(it.qtyAktual || 0));
      const selisih = qtyAktual - qtySistem;
      doc.items.push({
        stokId: prod.id, kode: prod.kode, nama: prod.nama, satuan: prod.satuan,
        gudangKode: lokasiKode, qtySistem, qtyAktual, selisih,
      });
      await setQtyStokLokasi(db, tenantId, prod.id, lokasiKode, qtyAktual);
      await purgeOtherWarehouseRows(db, tenantId, prod.id, lokasiKode);
      await syncProductStokFromLokasi(db, tenantId, prod.id);
      await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
        id: uuidv4(),
        stokId: prod.id, lokasi: lokasiLabel, tanggal: now, noTransaksi: noPS,
        keterangan: `Penyesuaian Stok ${selisih >= 0 ? '(+)' : '(-)'}`,
        sourceType: 'PENYESUAIAN',
        masuk: selisih > 0 ? selisih : 0,
        keluar: selisih < 0 ? Math.abs(selisih) : 0,
        hargaSatuan: prod.hargaBeli || 0,
      }));
    }
    await db.collection('penyesuaian_stok').insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'STOCK_ADJUSTMENT',
      entityType: 'penyesuaian_stok',
      entityId: String(doc.id),
      summary: `Penyesuaian ${noPS} (${items.length} item)`,
      userId: String(invBody.userId || scopeAuth?.userId || ''),
      userName: String(invBody.userName || scopeAuth?.name || scopeAuth?.email || 'System'),
      metadata: { noPenyesuaian: noPS, itemCount: items.length },
    });
    return ok(clean(doc));
  }
  if (path[0] === 'stok' && path[1] === 'penyesuaian' && path.length === 3 && method === 'GET') {
    const deniedRole = requireRole(auth, STOCK_ADJUST_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const access = await assertOperationalAccess(db, scopeAuth, 'penyesuaian_stok', { id: path[2] });
    if ('error' in access) return access.error;
    return ok(clean(access.doc));
  }

  // ---------- PRODUKSI ----------
  if (route === '/stok/produksi' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const list = await db.collection('produksi')
      .find(withOperationalFilter(scopeAuth, {}))
      .sort({ tanggal: -1 })
      .limit(200)
      .toArray();
    return ok(list.map(clean));
  }
  if (route === '/stok/produksi' && method === 'POST') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: invBody, request });
    if (denied) return denied;
    const locked = await guardPosting(db, scopeAuth, invBody);
    if (locked) return locked;
    const bahan = invBody?.bahan || [];
    const hasil = invBody?.hasil || [];
    if (bahan.length === 0 || hasil.length === 0) return err('Bahan dan hasil wajib diisi');
    const tenantId = tenantIdForWrite(scopeAuth, invBody);
    for (const b of bahan) {
      const prodRaw = await findMasterDoc(db, 'products', scopeAuth, { id: String(b.stokId || '') });
      if (!prodRaw) return err(`Bahan ${b.kode || b.stokId} tidak ditemukan`, 404);
      const prod = asProductRow(prodRaw);
      const bQty = parseFloat(String(b.qty || 0));
      if ((prod.stok || 0) < bQty) return err(`Stok bahan ${prod.nama} tidak cukup (sisa: ${prod.stok})`, 400);
    }
    const now = new Date();
    const kodeProduksi = `TP${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`;
    const biayaProduksi = parseInt(String(invBody.biayaProduksi || 0), 10);

    const bahanItems: ProductionLineItem[] = [];
    let totalCostBahan = 0;
    for (const b of bahan) {
      const prodRaw = await findMasterDoc(db, 'products', scopeAuth, { id: String(b.stokId || '') });
      if (!prodRaw) return err(`Bahan ${b.kode || b.stokId} tidak ditemukan`, 404);
      const prod = asProductRow(prodRaw);
      const qty = parseFloat(String(b.qty || 0));
      const hargaBeli = prod.hargaBeli || 0;
      totalCostBahan += qty * hargaBeli;
      bahanItems.push({ stokId: prod.id, kode: prod.kode, nama: prod.nama, satuan: prod.satuan, qty, hargaBeli });
    }
    const totalCost = totalCostBahan + biayaProduksi;
    const totalHasilQty = hasil.reduce((s, h) => s + parseFloat(String(h.qty || 0)), 0);
    const hppPerUnit = totalHasilQty > 0 ? Math.round(totalCost / totalHasilQty) : 0;

    const hasilItems: ProductionLineItem[] = [];
    for (const h of hasil) {
      const prodRaw = await findMasterDoc(db, 'products', scopeAuth, { id: String(h.stokId || '') });
      if (!prodRaw) return err(`Hasil ${h.kode || h.stokId} tidak ditemukan`, 404);
      const prod = asProductRow(prodRaw);
      hasilItems.push({
        stokId: prod.id,
        kode: prod.kode,
        nama: prod.nama,
        satuan: prod.satuan,
        qty: parseFloat(String(h.qty || 0)),
        hargaBeli: hppPerUnit,
      });
    }

    const doc = stampTenantId(tenantId, {
      id: uuidv4(), kodeProduksi, tanggal: now, catatan: invBody.catatan || '',
      biayaProduksi, totalCostBahan, totalCost, hppPerUnit,
      userId: invBody.userId || '', userName: invBody.userName || '',
      bahan: bahanItems, hasil: hasilItems, createdAt: now,
    });

    for (const b of bahanItems) {
      await updateProductStockScoped(db, tenantId, b.stokId, { $inc: { stok: -b.qty }, $set: { updatedAt: now } });
      await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
        id: uuidv4(), stokId: b.stokId, tanggal: now, noTransaksi: kodeProduksi,
        keterangan: 'Produksi - Bahan', sourceType: 'PRODUKSI',
        masuk: 0, keluar: b.qty, hargaSatuan: b.hargaBeli,
      }));
    }
    for (const h of hasilItems) {
      await updateProductStockScoped(db, tenantId, h.stokId, {
        $inc: { stok: h.qty },
        $set: { updatedAt: now, hargaBeli: hppPerUnit },
      });
      await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
        id: uuidv4(), stokId: h.stokId, tanggal: now, noTransaksi: kodeProduksi,
        keterangan: 'Produksi - Hasil', sourceType: 'PRODUKSI',
        masuk: h.qty, keluar: 0, hargaSatuan: hppPerUnit,
      }));
    }
    await db.collection('produksi').insertOne(doc);
    return ok(clean(doc));
  }
  if (path[0] === 'stok' && path[1] === 'produksi' && path.length === 3 && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const access = await assertOperationalAccess(db, scopeAuth, 'produksi', { id: path[2] });
    if ('error' in access) return access.error;
    return ok(clean(access.doc));
  }

  // ---------- LOKASI MASTER ----------
  if (route === '/lokasi' && method === 'GET') {
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    await ensureWarehousesForTenant(db, tenantId);
    const filter = withTenantFilter(scopeAuth, { kode: { $in: WAREHOUSE_CODES } });
    const list = await db.collection('lokasi').find(filter).sort({ kode: 1 }).toArray();
    return ok(list.map(clean));
  }
  if (route === '/lokasi' && method === 'POST') {
    return err('Gudang tetap GKERING & GBASAH — tidak bisa menambah lokasi baru. Edit keterangan via PUT jika perlu.', 400);
  }
  if (path[0] === 'lokasi' && path.length === 2) {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: invBody, request });
    if (denied) return denied;
    const id = path[1];
    const access = await assertMasterAccess(db, scopeAuth, 'lokasi', { id });
    if (method === 'PUT') {
      if ('error' in access) return access.error;
      const lokExisting = access.doc;
      const kode = normalizeWarehouseKode(String(lokExisting.kode || ''));
      if (!isValidWarehouseKode(kode)) {
        return err('Hanya gudang GKERING & GBASAH yang dapat diedit', 400);
      }
      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (invBody?.keterangan !== undefined) update.keterangan = invBody.keterangan;
      if (invBody?.aktif !== undefined) update.aktif = !!invBody.aktif;
      await db.collection('lokasi').updateOne(
        withTenantFilter(scopeAuth, { id }),
        { $set: update },
      );
      return ok(clean(await findMasterDoc(db, 'lokasi', scopeAuth, { id })));
    }
    if (method === 'DELETE') {
      if ('error' in access) return access.error;
      const kode = normalizeWarehouseKode(String(access.doc.kode || ''));
      if (isValidWarehouseKode(kode)) {
        return err('Gudang utama tidak dapat dihapus', 400);
      }
      await db.collection('lokasi').deleteOne(withTenantFilter(scopeAuth, { id }));
      return ok({ message: 'deleted' });
    }
  }
  if (route === '/lokasi/bulk-delete' && method === 'POST') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: invBody, request });
    if (denied) return denied;
    return bulkDeleteMaster(db, scopeAuth, 'lokasi', invBody?.ids);
  }

  // ---------- TRANSFER STOK ----------
  if (route === '/stok/transfer' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const list = await db.collection('transfer_stok')
      .find(withOperationalFilter(scopeAuth, {}))
      .sort({ tanggal: -1 })
      .limit(200)
      .toArray();
    return ok(list.map(clean));
  }
  if (route === '/stok/transfer' && method === 'POST') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: invBody, request });
    if (denied) return denied;
    const locked = await guardPosting(db, scopeAuth, invBody);
    if (locked) return locked;
    if (!invBody?.lokasiAsal || !invBody?.lokasiTujuan) return err('Lokasi asal & tujuan wajib');
    if (invBody.lokasiAsal === invBody.lokasiTujuan) return err('Lokasi asal & tujuan tidak boleh sama');
    const items = invBody.items || [];
    if (items.length === 0) return err('Tidak ada item');
    const tenantId = tenantIdForWrite(scopeAuth, invBody);
    for (const it of items) {
      const stokId = itemStokId(it);
      const prodRaw = await findMasterDoc(db, 'products', scopeAuth, { id: stokId });
      if (!prodRaw) return err(`Produk ${it.kode || stokId} tidak ditemukan`, 404);
      const prod = asProductRow(prodRaw);
      const whCheckAsal = assertProductWarehouse(prod, invBody.lokasiAsal);
      if (whCheckAsal) return err(whCheckAsal.error, 400);
      const whCheckTujuan = assertProductWarehouse(prod, invBody.lokasiTujuan);
      if (whCheckTujuan) return err(whCheckTujuan.error, 400);
      await ensureStokLokasiRow(db, tenantId, stokId, invBody.lokasiAsal);
      const tr = await transferStokBetweenLokasi(
        db, tenantId, stokId, invBody.lokasiAsal!, invBody.lokasiTujuan!, parseFloat(String(it.qty || 0)),
      );
      if ('error' in tr && tr.error) return err(`Stok ${prod.nama}: ${tr.error}`, 400);
    }
    const now = new Date();
    const noTransfer = `TR${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`;
    const doc = stampTenantId(tenantId, {
      id: uuidv4(), noTransfer, tanggal: now,
      lokasiAsal: invBody.lokasiAsal, lokasiAsalNama: invBody.lokasiAsalNama || '',
      lokasiTujuan: invBody.lokasiTujuan, lokasiTujuanNama: invBody.lokasiTujuanNama || '',
      keterangan: invBody.keterangan || '', items, userName: invBody.userName || '', createdAt: now,
    });
    await db.collection('transfer_stok').insertOne(doc);
    for (const it of items) {
      const stokId = itemStokId(it);
      const qty = parseFloat(String(it.qty || 0));
      await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
        id: uuidv4(), stokId, lokasi: invBody.lokasiAsal, tanggal: now,
        noTransaksi: noTransfer, keterangan: `Transfer keluar ke ${invBody.lokasiTujuanNama || invBody.lokasiTujuan}`,
        sourceType: 'TRANSFER', masuk: 0, keluar: qty, hargaSatuan: it.hargaBeli || 0,
      }));
      await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
        id: uuidv4(), stokId, lokasi: invBody.lokasiTujuan, tanggal: now,
        noTransaksi: noTransfer, keterangan: `Transfer masuk dari ${invBody.lokasiAsalNama || invBody.lokasiAsal}`,
        sourceType: 'TRANSFER', masuk: qty, keluar: 0, hargaSatuan: it.hargaBeli || 0,
      }));
    }
    await writeAuditLog(db, {
      tenantId,
      action: 'STOCK_TRANSFER',
      entityType: 'transfer_stok',
      entityId: String(doc.id),
      summary: `Transfer ${noTransfer}`,
      userName: String(invBody.userName || scopeAuth?.name || scopeAuth?.email || 'System'),
      metadata: {
        noTransfer,
        lokasiAsal: invBody.lokasiAsal,
        lokasiTujuan: invBody.lokasiTujuan,
        itemCount: items.length,
      },
    });
    return ok(clean(doc));
  }

  return null;
}
