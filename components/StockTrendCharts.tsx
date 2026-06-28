'use client';

import { useMemo } from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { formatNumber } from '@/lib/format';
import { warehouseName } from '@/lib/warehouses-client';
import {
  CHART_MODE_LABEL,
  hasWarehouseActivity,
  prepareWarehouseChartData,
} from '@/lib/stock-trend-chart';

const KERING_CONFIG = {
  masuk: { label: 'Masuk', color: '#16a34a' },
  keluar: { label: 'Keluar', color: '#dc2626' },
  saldo: { label: 'Saldo', color: '#b45309' },
};

const BASAH_CONFIG = {
  masuk: { label: 'Masuk', color: '#059669' },
  keluar: { label: 'Keluar', color: '#e11d48' },
  saldo: { label: 'Saldo', color: '#0284c7' },
};

const LEGEND_ORDER = ['saldo', 'masuk', 'keluar'];

function ChartSeriesLegend({ config }) {
  return (
    <div className="flex flex-wrap justify-center gap-x-5 gap-y-1.5 pt-3 text-xs text-slate-600">
      {LEGEND_ORDER.map((key) => (
        <span key={key} className="inline-flex items-center gap-1.5">
          <span
            className="w-2.5 h-2.5 rounded-sm shrink-0"
            style={{ backgroundColor: config[key]?.color }}
            aria-hidden
          />
          {config[key]?.label}
        </span>
      ))}
    </div>
  );
}

function formatTooltipDate(payload) {
  const p = payload?.[0]?.payload;
  if (!p) return '';
  if (p.mode === 'weekly' || !p.period) return p.label || '';
  const d = new Date(`${p.period}T12:00:00`);
  return d.toLocaleDateString('id-ID', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function WarehouseComposedChart({
  title,
  subtitle,
  rawData,
  masukKey,
  keluarKey,
  saldoKey,
  config,
  accentClass,
}) {
  const { data, mode, activeCount, totalDays } = useMemo(
    () => prepareWarehouseChartData(rawData, masukKey, keluarKey, saldoKey),
    [rawData, masukKey, keluarKey, saldoKey],
  );

  const chartData = useMemo(
    () => data.map((d) => ({ ...d, mode })),
    [data, mode],
  );

  const hasActivity = rawData.some((d) => hasWarehouseActivity(d, masukKey, keluarKey));
  const totalMasuk = rawData.reduce((s, d) => s + (d[masukKey] || 0), 0);
  const totalKeluar = rawData.reduce((s, d) => s + (d[keluarKey] || 0), 0);
  const lastSaldo = rawData.length ? rawData[rawData.length - 1][saldoKey] : 0;

  return (
    <div className={`rounded-xl border p-4 shadow-sm ${accentClass}`}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          <p className="text-xs text-slate-500">{subtitle}</p>
          {mode !== 'daily' && (
            <p className="mt-1 text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-0.5 inline-block">
              Mode {CHART_MODE_LABEL[mode]} — {activeCount} dari {totalDays} hari punya transaksi
            </p>
          )}
        </div>
        <div className="flex gap-3 text-xs">
          <span className="text-green-700">↑ {formatNumber(totalMasuk)} masuk</span>
          <span className="text-red-600">↓ {formatNumber(totalKeluar)} keluar</span>
          <span className="font-semibold text-slate-700">Saldo: {formatNumber(lastSaldo)}</span>
        </div>
      </div>

      {!hasActivity ? (
        <div className="h-[280px] flex items-center justify-center text-sm text-slate-400 border border-dashed rounded-lg bg-white/60">
          Belum ada pergerakan di periode ini
        </div>
      ) : (
        <>
          <ChartContainer config={config} className="h-[300px] w-full aspect-auto">
            <ComposedChart data={chartData} margin={{ top: 8, right: 48, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10, fill: '#64748b' }}
                interval={chartData.length > 20 ? 'preserveStartEnd' : 0}
                minTickGap={mode === 'active' ? 8 : 28}
                angle={chartData.length > 8 ? -25 : 0}
                textAnchor={chartData.length > 8 ? 'end' : 'middle'}
                height={chartData.length > 8 ? 52 : 30}
              />
              <YAxis
                yAxisId="saldo"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10, fill: '#64748b' }}
                width={44}
                label={{
                  value: 'Saldo',
                  angle: -90,
                  position: 'insideLeft',
                  style: { fontSize: 9, fill: '#94a3b8' },
                }}
              />
              <YAxis
                yAxisId="flow"
                orientation="right"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10, fill: '#64748b' }}
                width={44}
                label={{
                  value: 'Masuk/Keluar',
                  angle: 90,
                  position: 'insideRight',
                  style: { fontSize: 9, fill: '#94a3b8' },
                }}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) => formatTooltipDate(payload)}
                    formatter={(value, name) => {
                      const labels = { masuk: 'Masuk', keluar: 'Keluar', saldo: 'Saldo akumulasi' };
                      return [formatNumber(value), labels[name] || name];
                    }}
                  />
                }
              />
              <Area
                yAxisId="saldo"
                type="monotone"
                dataKey={saldoKey}
                name="saldo"
                fill="var(--color-saldo)"
                fillOpacity={0.15}
                stroke="var(--color-saldo)"
                strokeWidth={2.5}
                dot={chartData.length <= 14}
                activeDot={{ r: 5 }}
              />
              <Bar
                yAxisId="flow"
                dataKey={masukKey}
                name="masuk"
                fill="var(--color-masuk)"
                radius={[3, 3, 0, 0]}
                barSize={chartData.length > 30 ? 6 : chartData.length > 14 ? 10 : 16}
                maxBarSize={20}
              />
              <Bar
                yAxisId="flow"
                dataKey={keluarKey}
                name="keluar"
                fill="var(--color-keluar)"
                radius={[3, 3, 0, 0]}
                barSize={chartData.length > 30 ? 6 : chartData.length > 14 ? 10 : 16}
                maxBarSize={20}
              />
            </ComposedChart>
          </ChartContainer>
          <ChartSeriesLegend config={config} />
        </>
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
        Area = saldo stok tertahan (akumulasi, sumbu kiri). Batang hijau/merah = masuk &amp; keluar
        per hari (sumbu kanan). Jika transaksi jarang, grafik otomatis menampilkan{' '}
        <strong>hari aktif</strong> atau <strong>agregasi mingguan</strong>.
        Saldo awal periode: {warehouseName('GKERING')} {formatNumber(opening.kering)},
        {' '}{warehouseName('GBASAH')} {formatNumber(opening.basah)}.
      </p>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <WarehouseComposedChart
          title={warehouseName('GKERING')}
          subtitle="Area saldo + batang masuk/keluar"
          rawData={data}
          masukKey="keringMasukQty"
          keluarKey="keringKeluarQty"
          saldoKey="keringSaldoKumulatif"
          config={KERING_CONFIG}
          accentClass="bg-gradient-to-br from-amber-50/80 to-white"
        />
        <WarehouseComposedChart
          title={warehouseName('GBASAH')}
          subtitle="Area saldo + batang masuk/keluar"
          rawData={data}
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
              sub: 'rentang penuh periode',
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
