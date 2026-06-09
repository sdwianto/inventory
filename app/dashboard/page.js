'use client';

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { PackageCheck, Package, Link2 } from 'lucide-react';

export default function DashboardPage() {
  const [stats, setStats] = useState({ grn: 0, draft: 0, needsMapping: 0, produk: 0 });

  useEffect(() => {
    Promise.all([
      fetch('/api/goods-receipts').then((r) => r.json()),
      fetch('/api/products').then((r) => r.json()),
    ]).then(([grns, products]) => {
      const list = Array.isArray(grns) ? grns : [];
      setStats({
        grn: list.length,
        draft: list.filter((g) => g.status === 'DRAFT').length,
        needsMapping: list.filter((g) => g.status === 'NEEDS_MAPPING').length,
        produk: Array.isArray(products) ? products.length : 0,
      });
    });
  }, []);

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-5">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-slate-500">Penerimaan barang dari sales.app & stok customer</p>
        </div>
        <OperationalScopeBar />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white border rounded-lg p-4">
            <PackageCheck className="w-5 h-5 text-blue-600 mb-2" />
            <div className="text-2xl font-bold">{stats.grn}</div>
            <div className="text-sm text-slate-500">Total GRN</div>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <div className="text-2xl font-bold text-blue-600">{stats.draft}</div>
            <div className="text-sm text-slate-500">Siap diterima</div>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <Link2 className="w-5 h-5 text-amber-600 mb-2" />
            <div className="text-2xl font-bold text-amber-600">{stats.needsMapping}</div>
            <div className="text-sm text-slate-500">Perlu mapping</div>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <Package className="w-5 h-5 text-slate-600 mb-2" />
            <div className="text-2xl font-bold">{stats.produk}</div>
            <div className="text-sm text-slate-500">Produk</div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
