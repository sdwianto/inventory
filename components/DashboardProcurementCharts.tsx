'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { formatIDR, formatNumber } from '@/lib/format';

const PO_CHART_CONFIG = {
  count: { label: 'Jumlah PO', color: '#3b82f6' },
};

const INV_QTY_CONFIG = {
  qty: { label: 'Qty stok', color: '#0ea5e9' },
  nilai: { label: 'Nilai persediaan', color: '#fdba74' },
};

const SPENDING_CONFIG = {
  total: { label: 'Belanja disetujui', color: '#16a34a' },
};

import type { JsonObject } from '@/types/json';
import { num, str } from '@/types/json';

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="h-[260px] flex items-center justify-center text-sm text-slate-400 border border-dashed rounded-lg bg-slate-50/50">
      {message}
    </div>
  );
}

export default function DashboardProcurementCharts({ data }: { data?: JsonObject | null }) {
  const poData = (data?.poByStatus || []) as JsonObject[];
  const invData = (data?.inventoryByWarehouse || []) as JsonObject[];
  const spendData = (data?.spendingByMonth || []) as JsonObject[];

  const totalPo = poData.reduce((s, r) => s + num(r.count), 0);
  const totalQty = invData.reduce((s, r) => s + num(r.qty), 0);
  const totalNilai = invData.reduce((s, r) => s + num(r.nilai), 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* 1. PO Status */}
      <div className="bg-white border rounded-lg p-4 shadow-sm">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-slate-800">Status PO ke Vendor</h3>
          <p className="text-xs text-slate-500">{totalPo} purchase order</p>
        </div>
        {!poData.length ? (
          <EmptyChart message="Belum ada PO" />
        ) : (
          <>
            <ChartContainer config={PO_CHART_CONFIG} className="h-[220px] w-full aspect-auto mx-auto max-w-[260px]">
              <PieChart>
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value, _name, item) => [
                        `${value} PO (${totalPo ? Math.round((Number(value) / totalPo) * 100) : 0}%)`,
                        str(item?.payload?.label),
                      ]}
                    />
                  }
                />
                <Pie
                  data={poData}
                  dataKey="count"
                  nameKey="label"
                  cx="50%"
                  cy="50%"
                  innerRadius={48}
                  outerRadius={80}
                  paddingAngle={2}
                >
                  {poData.map((entry) => (
                    <Cell key={str(entry.status)} fill={str(entry.fill)} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
            <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs border-t pt-3">
              {poData.map((entry) => (
                <li key={str(entry.status)} className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-2.5 h-2.5 rounded-sm shrink-0"
                    style={{ backgroundColor: str(entry.fill) }}
                    aria-hidden
                  />
                  <span className="text-slate-700 truncate flex-1">{str(entry.label)}</span>
                  <span className="text-slate-500 tabular-nums shrink-0">
                    {num(entry.count)}
                    <span className="text-slate-400 ml-1">
                      ({totalPo ? Math.round((num(entry.count) / totalPo) * 100) : 0}%)
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* 2. Inventory per gudang */}
      <div className="bg-white border rounded-lg p-4 shadow-sm">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-slate-800">Stok per Gudang</h3>
          <p className="text-xs text-slate-500">
            {formatNumber(totalQty)} unit · nilai {formatIDR(totalNilai)}
          </p>
        </div>
        {!invData.some((r) => num(r.qty) > 0) ? (
          <EmptyChart message="Belum ada stok di gudang" />
        ) : (
          <ChartContainer config={INV_QTY_CONFIG} className="h-[260px] w-full aspect-auto">
            <BarChart data={invData} margin={{ top: 8, right: 8, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
              <YAxis
                yAxisId="qty"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10 }}
                width={40}
                tickFormatter={(v) => formatNumber(v)}
              />
              <YAxis
                yAxisId="nilai"
                orientation="right"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 9 }}
                width={52}
                tickFormatter={(v) => `${Math.round(v / 1000)}k`}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, name) => {
                      if (name === 'qty') return [formatNumber(Number(value)), 'Qty stok'];
                      if (name === 'nilai') return [formatIDR(Number(value)), 'Nilai (harga beli)'];
                      return [String(value), String(name)];
                    }}
                    labelFormatter={(_, payload) => {
                      const p = payload?.[0]?.payload as JsonObject | undefined;
                      return p ? `${str(p.label)} · ${num(p.skuCount)} SKU` : '';
                    }}
                  />
                }
              />
              <Bar yAxisId="qty" dataKey="qty" name="qty" fill="var(--color-qty)" radius={[4, 4, 0, 0]} barSize={36} />
              <Bar yAxisId="nilai" dataKey="nilai" name="nilai" fill="#fdba74" radius={[4, 4, 0, 0]} barSize={36} />
            </BarChart>
          </ChartContainer>
        )}
        <div className="flex gap-3 mt-2 text-[10px] text-slate-500 justify-center">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-sky-500" /> Qty</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-orange-300" /> Nilai persediaan</span>
        </div>
      </div>

      {/* 3. Nilai belanja */}
      <div className="bg-white border rounded-lg p-4 shadow-sm">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-slate-800">Nilai Belanja Pengadaan</h3>
          <p className="text-xs text-slate-500">Tagihan disetujui · 6 bulan terakhir</p>
        </div>
        {!spendData.some((r) => num(r.total) > 0) ? (
          <EmptyChart message="Belum ada belanja disetujui" />
        ) : (
          <ChartContainer config={SPENDING_CONFIG} className="h-[260px] w-full aspect-auto">
            <BarChart data={spendData} margin={{ top: 8, right: 8, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 10 }} />
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 9 }}
                width={48}
                tickFormatter={(v) => `${Math.round(v / 1000)}k`}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, _name, item) => [
                      formatIDR(Number(value)),
                      `${num(item?.payload?.count)} invoice`,
                    ]}
                    labelFormatter={(label) => `Bulan ${str(label)}`}
                  />
                }
              />
              <Bar dataKey="total" name="total" fill="var(--color-total)" radius={[4, 4, 0, 0]} barSize={28} />
            </BarChart>
          </ChartContainer>
        )}
      </div>
    </div>
  );
}
