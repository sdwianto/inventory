/** Transformasi data trend stok untuk chart — mode harian, hari aktif, atau mingguan. */

const SPARSE_RATIO = 0.1;
const MIN_DAYS_FOR_SPARSE = 14;
const WEEKLY_MIN_TOTAL_DAYS = 45;

export function hasWarehouseActivity(row, masukKey, keluarKey) {
  return (parseFloat(row[masukKey]) || 0) + (parseFloat(row[keluarKey]) || 0) > 0;
}

function weekStartKey(period) {
  const d = new Date(`${period}T12:00:00`);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setDate(diff);
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, '0');
  const dayNum = String(monday.getDate()).padStart(2, '0');
  return `${y}-${m}-${dayNum}`;
}

function weekLabel(weekStart) {
  const start = new Date(`${weekStart}T12:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmt = (x) => x.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  return `Mgg ${fmt(start)}–${fmt(end)}`;
}

/** Agregasi harian → mingguan; saldo = nilai akhir minggu. */
export function rollupWeekly(periods, masukKey, keluarKey, saldoKey) {
  const buckets = new Map();
  for (const row of periods) {
    const wk = weekStartKey(row.period);
    if (!buckets.has(wk)) {
      buckets.set(wk, {
        period: wk,
        label: weekLabel(wk),
        masuk: 0,
        keluar: 0,
        saldo: 0,
        transaksi: 0,
      });
    }
    const b = buckets.get(wk);
    b.masuk += parseFloat(row[masukKey]) || 0;
    b.keluar += parseFloat(row[keluarKey]) || 0;
    b.transaksi += row.transaksi || 0;
    b.saldo = parseFloat(row[saldoKey]) || 0;
  }
  return [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * Pilih representasi chart: daily | active | weekly.
 * Sparse = <10% hari punya transaksi dalam periode panjang.
 */
export function prepareWarehouseChartData(periods, masukKey, keluarKey, saldoKey) {
  if (!periods?.length) {
    return { data: [], mode: 'daily', activeCount: 0, totalDays: 0 };
  }

  const active = periods.filter((d) => hasWarehouseActivity(d, masukKey, keluarKey));
  const totalDays = periods.length;
  const activeCount = active.length;
  const ratio = activeCount / totalDays;

  if (totalDays >= MIN_DAYS_FOR_SPARSE && ratio < SPARSE_RATIO) {
    if (totalDays >= WEEKLY_MIN_TOTAL_DAYS && activeCount >= 2) {
      const weekly = rollupWeekly(periods, masukKey, keluarKey, saldoKey);
      return {
        data: weekly.map((w) => ({
          period: w.period,
          label: w.label,
          [masukKey]: w.masuk,
          [keluarKey]: w.keluar,
          [saldoKey]: w.saldo,
          transaksi: w.transaksi,
        })),
        mode: 'weekly',
        activeCount,
        totalDays,
      };
    }
    if (activeCount > 0) {
      return {
        data: active.map((d) => ({
          ...d,
          label: d.period
            ? new Date(`${d.period}T12:00:00`).toLocaleDateString('id-ID', {
              weekday: 'short', day: 'numeric', month: 'short',
            })
            : d.label,
        })),
        mode: 'active',
        activeCount,
        totalDays,
      };
    }
  }

  return { data: periods, mode: 'daily', activeCount, totalDays };
}

export const CHART_MODE_LABEL = {
  daily: 'Harian',
  active: 'Hari aktif saja',
  weekly: 'Agregasi mingguan',
};
