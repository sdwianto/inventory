// Dashboard analytics — aggregation ringan (tanpa load dokumen transaksi penuh).

import { ok, clean } from '@/lib/api/db';
import { mergeTenantScopeFromAuth } from '@/lib/api/tenant-scope';
import { withTenantFilter } from '@/lib/api/tenant-master';

async function sumTransactions(db, filter) {
  const [row] = await db.collection('transactions').aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        omzet: { $sum: { $ifNull: ['$total', 0] } },
        count: { $sum: 1 },
      },
    },
  ]).toArray();
  return { omzet: row?.omzet || 0, count: row?.count || 0 };
}

export async function handleDashboard({ db, route, method, url, auth }) {
  if (route !== '/dashboard' || method !== 'GET') return null;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const last7 = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const todayFilter = mergeTenantScopeFromAuth({ tanggal: { $gte: todayStart } }, auth);
  const yesterdayFilter = mergeTenantScopeFromAuth({ tanggal: { $gte: yesterdayStart, $lt: todayStart } }, auth);
  const weekFilter = mergeTenantScopeFromAuth({ tanggal: { $gte: last7 } }, auth);
  const monthFilter = mergeTenantScopeFromAuth({ tanggal: { $gte: monthStart } }, auth);

  const [todayStats, yStats, chartAgg, topProducts, lowStock, lowStockCount] = await Promise.all([
    sumTransactions(db, todayFilter),
    sumTransactions(db, yesterdayFilter),
    db.collection('transactions').aggregate([
      { $match: weekFilter },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$tanggal' } },
          omzet: { $sum: { $ifNull: ['$total', 0] } },
          jumlah: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]).toArray(),
    db.collection('transactions').aggregate([
      { $match: monthFilter },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.stokId',
          nama: { $first: '$items.nama' },
          qty: { $sum: { $ifNull: ['$items.qty', 0] } },
          jumlah: { $sum: { $ifNull: ['$items.jumlah', 0] } },
        },
      },
      { $sort: { jumlah: -1 } },
      { $limit: 10 },
    ]).toArray(),
    db.collection('products').find({
      ...withTenantFilter(auth, { aktif: true }),
      $expr: { $lte: [{ $ifNull: ['$stok', 0] }, { $ifNull: ['$minStok', 0] }] },
    })
      .project({ kode: 1, nama: 1, stok: 1, minStok: 1, satuan: 1 })
      .sort({ stok: 1 })
      .limit(10)
      .toArray(),
    db.collection('products').countDocuments({
      ...withTenantFilter(auth, { aktif: true }),
      $expr: { $lte: [{ $ifNull: ['$stok', 0] }, { $ifNull: ['$minStok', 0] }] },
    }),
  ]);

  const chartMap = Object.fromEntries(chartAgg.map((d) => [d._id, d]));
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(todayStart.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const row = chartMap[key];
    days.push({
      date: d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }),
      omzet: row?.omzet || 0,
      jumlah: row?.jumlah || 0,
    });
  }

  const omzetHariIni = todayStats.omzet;
  const trxHariIni = todayStats.count;
  const avgTrx = trxHariIni > 0 ? Math.round(omzetHariIni / trxHariIni) : 0;

  return ok({
    omzetHariIni,
    omzetKemarin: yStats.omzet,
    trxHariIni,
    avgTrx,
    lowStockCount,
    lowStock: lowStock.map(clean),
    chart7Days: days,
    topProducts: topProducts.map((p) => ({
      nama: p.nama,
      qty: p.qty,
      jumlah: p.jumlah,
    })),
  });
}
