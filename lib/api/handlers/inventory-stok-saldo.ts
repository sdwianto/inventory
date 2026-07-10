import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import { withTenantFilter, resolveOperationalScope } from '@/lib/api/tenant-master';
import { getStokByWarehouseBatch } from '@/lib/api/stok-lokasi';
import { warehouseLabel, WAREHOUSE_CODES, normalizeWarehouseKode, isValidWarehouseKode } from '@/lib/api/warehouses';
import { resolveProductGudangKode } from '@/lib/api/product-warehouse';
import { qtyAtWarehouse } from '@/lib/api/warehouse-qty';
import { listProductUomsByProductIds } from '@/lib/api/product-uom';
import { formatStockDualLabel } from '@/lib/uom/display';
import type { HandlerContext } from '@/types/api/handler';

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
  const cap = new Date(since);
  cap.setMonth(cap.getMonth() - 24);
  const rows = await db.collection('stok_kartu').aggregate([
    { $match: { tenantId: tid, tanggal: { $gte: cap, $lt: since } } },
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

function resolveTrendGranularity(months: number, requested?: string | null): 'day' | 'month' {
  const g = (requested || '').toLowerCase();
  if (g === 'day' || g === 'month') return g;
  return months <= 1 ? 'day' : 'month';
}

async function buildStockTrend(
  db: HandlerContext['db'],
  tenantId: string | null | undefined,
  { months = 6, granularity: requestedGranularity = 'day' }: { months?: number; granularity?: string } = {},
) {
  const tid = tenantId || 'default';
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  since.setHours(0, 0, 0, 0);
  const until = new Date();
  until.setHours(23, 59, 59, 999);

  let granularity = resolveTrendGranularity(months, requestedGranularity);
  const daySpan = (until.getTime() - since.getTime()) / 86_400_000;
  if (granularity === 'day' && daySpan > 31) granularity = 'month';

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

export async function handleStokSaldo({
  db,
  route,
  method,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  if (route !== '/stok/saldo' || method !== 'GET') return null;

  const { denied, scopeAuth, tenantId: tid } = resolveOperationalScope(auth, { url, request });
  if (denied) return denied;
  if (!tid) return err('Scope tidak valid', 400);

  const part = (url.searchParams.get('part') || 'all').toLowerCase();
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const trendMonths = Math.min(24, Math.max(1, parseInt(url.searchParams.get('trendMonths') || '3', 10)));

  if (part === 'trend') {
    const granularity = resolveTrendGranularity(
      trendMonths,
      url.searchParams.get('granularity'),
    );
    const trend = await buildStockTrend(db, tid, { months: trendMonths, granularity });
    return ok({ trend });
  }

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
  const uomMap = await listProductUomsByProductIds(db, tid, products.map((p) => String(p.id)));
  const stokMap = await getStokByWarehouseBatch(db, tid, products.map((p) => p.id));
  let summaryQtyKering = 0;
  let summaryQtyBasah = 0;
  let summaryNilaiKering = 0;
  let summaryNilaiBasah = 0;
  let skuAktif = 0;

  const rows = products.map((p) => {
    const gudangKode = resolveProductGudangKode(p);
    const byWh = stokMap.get(p.id) || Object.fromEntries(WAREHOUSE_CODES.map((k) => [k, 0]));
    const qtyKering = qtyAtWarehouse(byWh, 'GKERING');
    const qtyBasah = qtyAtWarehouse(byWh, 'GBASAH');
    const stokQty = qtyAtWarehouse(byWh, gudangKode);
    const uoms = uomMap.get(String(p.id)) || [];
    const hargaBeli = parseInt(p.hargaBeli || 0, 10);
    const nilaiStok = Math.round(stokQty * hargaBeli);
    const nilaiKering = Math.round(qtyKering * hargaBeli);
    const nilaiBasah = Math.round(qtyBasah * hargaBeli);

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
      stokDisplay: formatStockDualLabel(stokQty, uoms),
      nilaiStok,
      stokGudangKering: qtyKering,
      stokGudangBasah: qtyBasah,
      stokByWarehouse: {
        GKERING: qtyKering,
        GBASAH: qtyBasah,
      },
      stokTotal: qtyKering + qtyBasah,
      nilaiGudangKering: nilaiKering,
      nilaiGudangBasah: nilaiBasah,
      nilaiTotal: nilaiKering + nilaiBasah,
    });
  });

  const summary = {
    qtyKering: summaryQtyKering,
    qtyBasah: summaryQtyBasah,
    qtyTotal: summaryQtyKering + summaryQtyBasah,
    nilaiKering: summaryNilaiKering,
    nilaiBasah: summaryNilaiBasah,
    nilaiTotal: summaryNilaiKering + summaryNilaiBasah,
    skuAktif,
    skuTotal: rows.length,
  };

  if (part === 'rows') {
    return ok({
      warehouses: WAREHOUSE_CODES.map((k) => ({ kode: k, nama: warehouseLabel(k) })),
      summary,
      rows,
    });
  }

  const trend = await buildStockTrend(db, tid, { months: trendMonths, granularity: 'day' });

  return ok({
    warehouses: WAREHOUSE_CODES.map((k) => ({ kode: k, nama: warehouseLabel(k) })),
    summary,
    trend,
    rows,
  });
}
