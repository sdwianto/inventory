'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from '@/components/ui/chart';
import { formatNumber } from '@/lib/format';
import { warehouseName } from '@/lib/warehouses-client';

const KERING_CONFIG = {
  masuk: { label: 'Masuk (qty)', color: '#16a34a' },
  keluar: { label: 'Keluar (qty)', color: '#dc2626' },
  saldo: { label: 'Saldo harian (akumulasi)', color: '#b45309' },
};

const BASAH_CONFIG = {
  masuk: { label: 'Masuk (qty)', color: '#059669' },
  keluar: { label: 'Keluar (qty)', color: '#e11d48' },
  saldo: { label: 'Saldo harian (akumulasi)', color: '#0284c7' },
};

function WarehouseDailyChart({
  title,
  subtitle,
  data,
  masukKey,
  keluarKey,
  saldoKey,
  config,
  accentClass,
}) {
  const hasActivity = data.some((d) => (d[masukKey] || 0) + (d[keluarKey] || 0) > 0);
  const lastSaldo = data.length ? data[data.length - 1][saldoKey] : 0;
  const totalMasuk = data.reduce((s, d) => s + (d[masukKey] || 0), 0);
  const totalKeluar = data.reduce((s, d) => s + (d[keluarKey] || 0), 0);

  return (
    <div className={`rounded-xl border p-4 shadow-sm ${accentClass}`}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          <p className="text-xs text-slate-500">{subtitle}</p>
        </div>
        <div className="flex gap-3 text-xs">
          <span className="text-green-700">↑ {formatNumber(totalMasuk)} masuk</span>
          <span className="text-red-600">↓ {formatNumber(totalKeluar)} keluar</span>
          <span className="font-semibold text-slate-700">Saldo: {formatNumber(lastSaldo)}</span>
        </div>
      </div>

      {!hasActivity && data.length <= 1 ? (
        <div className="h-[260px] flex items-center justify-center text-sm text-slate-400 border border-dashed rounded-lg bg-white/60">
          Belum ada pergerakan di periode ini
        </div>
      ) : (
        <ChartContainer config={config} className="h-[280px] w-full aspect-auto">
          <LineChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10, fill: '#64748b' }}
              interval="preserveStartEnd"
              minTickGap={28}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10, fill: '#64748b' }}
              width={40}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => {
                    const p = payload?.[0]?.payload;
                    if (!p?.period) return p?.label || '';
                    const d = new Date(`${p.period}T12:00:00`);
                    return d.toLocaleDateString('id-ID', {
                      weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
                    });
                  }}
                  formatter={(value, name) => {
                    const labels = { masuk: 'Masuk', keluar: 'Keluar', saldo: 'Saldo akumulasi' };
                    return [formatNumber(value), labels[name] || name];
                  }}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Line
              type="monotone"
              dataKey={masukKey}
              name="masuk"
              stroke="var(--color-masuk)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              type="monotone"
              dataKey={keluarKey}
              name="keluar"
              stroke="var(--color-keluar)"
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              type="monotone"
              dataKey={saldoKey}
              name="saldo"
              stroke="var(--color-saldo)"
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ChartContainer>
      )}
    </div>
  );
}

export default function StockTrendCharts({ trend }) {
  const data = trend?.periods || [];

  if (!data.length) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-400 bg-slate-50/50 rounded-lg border border-dashed">
        <p className="text-sm">Belum ada pergerakan stok untuk ditampilkan</p>
        <p className="text-xs mt-1">Data muncul setelah GRN, release, atau transfer tercatat</p>
      </div>
    );
  }

  const opening = trend.opening || { kering: 0, basah: 0, total: 0 };

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500 bg-slate-50 border rounded-lg px-3 py-2">
        Grafik harian — garis hijau = barang masuk, merah putus-putus = keluar, garis tebal = saldo stok
        tertahan (akumulasi). Saldo awal periode: {warehouseName('GKERING')} {formatNumber(opening.kering)},
        {' '}{warehouseName('GBASAH')} {formatNumber(opening.basah)}.
      </p>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <WarehouseDailyChart
          title={warehouseName('GKERING')}
          subtitle="Perbandingan masuk vs keluar & saldo harian"
          data={data}
          masukKey="keringMasukQty"
          keluarKey="keringKeluarQty"
          saldoKey="keringSaldoKumulatif"
          config={KERING_CONFIG}
          accentClass="bg-gradient-to-br from-amber-50/80 to-white"
        />
        <WarehouseDailyChart
          title={warehouseName('GBASAH')}
          subtitle="Perbandingan masuk vs keluar & saldo harian"
          data={data}
          masukKey="basahMasukQty"
          keluarKey="basahKeluarQty"
          saldoKey="basahSaldoKumulatif"
          config={BASAH_CONFIG}
          accentClass="bg-gradient-to-br from-blue-50/80 to-white"
        />
      </div>

      {trend?.totals && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            {
              label: `${warehouseName('GKERING')} — net`,
              value: `${trend.totals.keringMasukQty - trend.totals.keringKeluarQty >= 0 ? '+' : ''}${formatNumber(trend.totals.keringMasukQty - trend.totals.keringKeluarQty)}`,
              sub: `${formatNumber(trend.totals.keringMasukQty)} masuk / ${formatNumber(trend.totals.keringKeluarQty)} keluar`,
              color: 'text-amber-800',
            },
            {
              label: `${warehouseName('GBASAH')} — net`,
              value: `${trend.totals.basahMasukQty - trend.totals.basahKeluarQty >= 0 ? '+' : ''}${formatNumber(trend.totals.basahMasukQty - trend.totals.basahKeluarQty)}`,
              sub: `${formatNumber(trend.totals.basahMasukQty)} masuk / ${formatNumber(trend.totals.basahKeluarQty)} keluar`,
              color: 'text-blue-800',
            },
            {
              label: 'Total net periode',
              value: `${trend.totals.netQty >= 0 ? '+' : ''}${formatNumber(trend.totals.netQty)}`,
              sub: `${formatNumber(trend.totals.transaksi)} transaksi kartu stok`,
              color: trend.totals.netQty >= 0 ? 'text-green-700' : 'text-red-600',
            },
            {
              label: 'Hari dalam grafik',
              value: formatNumber(data.length),
              sub: 'agregasi per hari',
              color: 'text-slate-700',
            },
          ].map((s) => (
            <div key={s.label} className="rounded-lg bg-white border px-3 py-2.5">
              <p className="text-[10px] uppercase text-slate-500 tracking-wide">{s.label}</p>
              <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
              <p className="text-[10px] text-slate-400">{s.sub}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
