'use client';

import type { JsonObject } from '@/types/json';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import DashboardProcurementCharts from '@/components/DashboardProcurementCharts';
import DashboardMaintenanceSection from '@/components/DashboardMaintenanceSection';
import { PackageCheck, Package, Banknote, TrendingDown } from 'lucide-react';
import { formatIDR } from '@/lib/format';
import Link from 'next/link';
import { fetchJson } from '@/lib/fetch-json';
import { toast } from 'sonner';

interface DashboardSummary {
  grn: number;
  draft: number;
  unknownProduct?: number;
  needsMapping?: number;
  produk: number;
  pendingReview: number;
  approvedMonth: number;
}

interface DashboardData {
  summary?: DashboardSummary;
  poByStatus?: unknown[];
  inventoryByWarehouse?: unknown[];
  spendingByMonth?: unknown[];
}

const EMPTY_SUMMARY: DashboardSummary = {
  grn: 0,
  draft: 0,
  unknownProduct: 0,
  produk: 0,
  pendingReview: 0,
  approvedMonth: 0,
};

export default function DashboardPage() {
  const [chartData, setChartData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJson<DashboardData>('/api/dashboard')
      .then((data) => {
        if (data?.summary) setChartData(data);
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const stats = chartData?.summary || EMPTY_SUMMARY;

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-5">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-slate-500">Penerimaan barang, belanja pengadaan & maintenance aset</p>
        </div>
        <OperationalScopeBar />
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <div className="bg-white border rounded-lg p-4">
            <PackageCheck className="w-5 h-5 text-blue-600 mb-2" />
            <div className="text-2xl font-bold">{stats.grn}</div>
            <div className="text-sm text-slate-500">Total GRN</div>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <div className="text-2xl font-bold text-blue-600">{stats.draft}</div>
            <div className="text-sm text-slate-500">Siap diterima</div>
          </div>
          <Link href="/penerimaan" className="bg-white border rounded-lg p-4 hover:border-amber-300 transition-colors">
            <div className="text-2xl font-bold text-amber-600">{stats.unknownProduct ?? stats.needsMapping ?? 0}</div>
            <div className="text-sm text-slate-500">GRN — produk belum terdaftar</div>
          </Link>
          <div className="bg-white border rounded-lg p-4">
            <Package className="w-5 h-5 text-slate-600 mb-2" />
            <div className="text-2xl font-bold">{stats.produk}</div>
            <div className="text-sm text-slate-500">Produk</div>
          </div>
          <Link href="/hutang" className="bg-white border rounded-lg p-4 hover:border-orange-300 transition-colors">
            <Banknote className="w-5 h-5 text-orange-600 mb-2" />
            <div className="text-2xl font-bold text-orange-600">{stats.pendingReview}</div>
            <div className="text-sm text-slate-500">Tagihan review</div>
          </Link>
          <Link href="/pengeluaran-pengadaan" className="bg-white border rounded-lg p-4 hover:border-orange-300 transition-colors">
            <TrendingDown className="w-5 h-5 text-green-600 mb-2" />
            <div className="text-lg font-bold text-green-700 leading-tight">{formatIDR(stats.approvedMonth)}</div>
            <div className="text-sm text-slate-500">Belanja bulan ini</div>
          </Link>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-white border rounded-lg p-4 h-[320px] animate-pulse bg-slate-50" />
            ))}
          </div>
        ) : (
          <>
            <DashboardProcurementCharts data={chartData as JsonObject | null} />
            <DashboardMaintenanceSection data={chartData as JsonObject | null} />
          </>
        )}
      </div>
    </AppShell>
  );
}
