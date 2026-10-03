'use client';

import type { JsonObject } from '@/types/json';
import { str, num, asObject, asArray } from '@/types/json';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import OperationalScopeBar from '@/components/OperationalScopeBar';
import VendorInvoiceDetail from '@/components/VendorInvoiceDetail';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Receipt, Download, Eye, Loader2 } from 'lucide-react';
import { formatIDR, formatDate } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { queryKeys } from '@/lib/query-keys';
import { fetchJson } from '@/lib/fetch-json';

const STATUS_LABEL: Record<string, string> = {
  SIAP_DIKREDITKAN: 'Siap dikreditkan',
  MENUNGGU_FAKTUR: 'Menunggu faktur',
  FAKTUR_BATAL: 'Faktur batal/diganti',
  TIDAK_DIKREDITKAN: 'Tidak dikreditkan (non-PKP)',
};

const STATUS_CLASS: Record<string, string> = {
  SIAP_DIKREDITKAN: 'bg-green-100 text-green-800',
  MENUNGGU_FAKTUR: 'bg-amber-100 text-amber-800',
  FAKTUR_BATAL: 'bg-red-100 text-red-700',
  TIDAK_DIKREDITKAN: 'bg-slate-100 text-slate-600',
};

function currentMasaWib() {
  const d = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 7);
}

function csvCell(v: unknown) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function PpnMasukanPage() {
  const [masa, setMasa] = useState(currentMasaWib);
  const [detail, setDetail] = useState<JsonObject | null>(null);
  const [loadingDetail, setLoadingDetail] = useState('');
  const queryClient = useQueryClient();

  const { data, isLoading } = useApiQuery<JsonObject>(
    queryKeys.ppnMasukan.report(masa),
    `/api/ppn-masukan?${new URLSearchParams({ masa })}`,
    { enabled: /^\d{4}-\d{2}$/.test(masa) },
  );

  const rows = asArray(data?.rows) as JsonObject[];
  const summary = asObject(data?.summary);
  const tax = asObject(data?.tax);
  const bucket = (k: string) => asObject(summary[k]);

  const exportCsv = () => {
    if (!rows.length) { toast.error('Tidak ada data'); return; }
    const header = [
      'Tanggal', 'No Invoice', 'No Hutang', 'Supplier', 'NPWP Vendor', 'DPP', 'PPN', 'Tarif',
      'Nomor Faktur', 'Status Faktur', 'Masa Faktur', 'PPN Faktur', 'Selisih PPN', 'Status', 'Status Tagihan',
    ];
    const lines = rows.map((r) => [
      r.tanggal ? formatDate(str(r.tanggal)) : '',
      str(r.noInvoice), str(r.noHutang), str(r.supplierName), str(r.vendorNPWP),
      num(r.dpp), num(r.ppn), r.ppnRate == null ? '' : num(r.ppnRate),
      str(r.nomorFaktur), str(r.fakturStatus), str(r.fakturMasa),
      r.fakturPpn == null ? '' : num(r.fakturPpn), r.selisihPpn == null ? '' : num(r.selisihPpn),
      STATUS_LABEL[str(r.status)] || str(r.status), str(r.approvalStatus),
    ].map(csvCell).join(','));
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ppn-masukan-${masa}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openDetail = async (id: string) => {
    if (!id) return;
    setLoadingDetail(id);
    try {
      const res = await queryClient.fetchQuery({
        queryKey: queryKeys.hutang.detail(id),
        queryFn: () => fetchJson<JsonObject>(`/api/hutang/${id}`),
      });
      setDetail(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setLoadingDetail('');
  };

  const cards: Array<{ key: string; label: string; className: string }> = [
    { key: 'SIAP_DIKREDITKAN', label: 'Siap dikreditkan', className: 'text-green-700' },
    { key: 'MENUNGGU_FAKTUR', label: 'Menunggu faktur', className: 'text-amber-700' },
    { key: 'FAKTUR_BATAL', label: 'Faktur batal/diganti', className: 'text-red-600' },
    { key: 'TIDAK_DIKREDITKAN', label: 'Tidak dikreditkan', className: 'text-slate-600' },
  ];

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Receipt className="w-6 h-6" /> PPN Masukan
          </h1>
          <p className="text-sm text-slate-500">
            Tagihan vendor ber-PPN per masa pajak — masa faktur bila faktur sudah diterima, selain itu tanggal invoice.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}>
          <Download className="w-4 h-4 mr-1" /> Export CSV
        </Button>
      </div>
      <OperationalScopeBar />

      {data != null && tax.pkp !== true && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Tenant ini belum ditandai PKP di Pengaturan Tenant. PPN dari tagihan baru tidak dikreditkan dan masuk ke nilai barang.
        </div>
      )}

      <div className="flex flex-wrap gap-3 items-end bg-white border rounded-lg p-4">
        <div>
          <label className="text-xs text-slate-500 block mb-1">Masa pajak</label>
          <Input type="month" value={masa} onChange={(e) => setMasa(e.target.value)} className="w-44" />
        </div>
        {isLoading && <Loader2 className="w-4 h-4 text-orange-500 animate-spin mb-2" />}
      </div>

      {data != null && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {cards.map((c) => (
            <div key={c.key} className="bg-white border rounded-lg p-4">
              <div className={`text-2xl font-bold ${c.className}`}>{formatIDR(num(bucket(c.key).ppn))}</div>
              <div className="text-sm text-slate-500">{c.label} ({num(bucket(c.key).count)})</div>
            </div>
          ))}
        </div>
      )}

      {num(summary.selisihCount) > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {num(summary.selisihCount)} tagihan punya PPN faktur berbeda dari PPN tagihan — cek sebelum dikreditkan.
        </div>
      )}
      {data?.truncated === true && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Data dipotong pada 5.000 tagihan pertama.
        </div>
      )}

      <div className="bg-white border rounded-lg overflow-x-auto">
        <table className="w-full text-sm min-w-[960px]">
          <thead className="bg-slate-100 text-xs uppercase text-slate-600">
            <tr>
              <th className="px-3 py-2 text-left">Tanggal</th>
              <th className="px-3 py-2 text-left">Invoice</th>
              <th className="px-3 py-2 text-left">Supplier</th>
              <th className="px-3 py-2 text-right">DPP</th>
              <th className="px-3 py-2 text-right">PPN</th>
              <th className="px-3 py-2 text-left">Faktur pajak</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {!rows.length && (
              <tr><td colSpan={8} className="text-center py-10 text-slate-400">Tidak ada tagihan ber-PPN di masa ini</td></tr>
            )}
            {rows.map((r) => {
              const id = str(r.hutangId);
              const selisih = r.selisihPpn == null ? 0 : num(r.selisihPpn);
              return (
                <tr key={id} className="border-t cursor-pointer hover:bg-orange-50/60" onClick={() => openDetail(id)}>
                  <td className="px-3 py-2 text-xs">{r.tanggal ? formatDate(str(r.tanggal)) : '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{str(r.noInvoice)}</td>
                  <td className="px-3 py-2 text-xs max-w-[180px]">
                    <div className="truncate" title={str(r.supplierName)}>{str(r.supplierName) || '—'}</div>
                    {str(r.vendorNPWP) && <div className="text-[10px] text-slate-500 font-mono">{str(r.vendorNPWP)}</div>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatIDR(num(r.dpp))}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium">
                    {formatIDR(num(r.ppn))}
                    {Math.abs(selisih) > 1 && (
                      <div className="text-[10px] text-red-600 font-normal">Faktur {formatIDR(num(r.fakturPpn))}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {str(r.nomorFaktur) ? <div className="font-mono">{str(r.nomorFaktur)}</div> : <span className="text-slate-400">—</span>}
                    {str(r.fakturStatus) && <div className="text-[10px] text-slate-500">{str(r.fakturStatus)}{str(r.fakturMasa) ? ` · masa ${str(r.fakturMasa)}` : ''}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span className={`inline-block rounded px-2 py-0.5 ${STATUS_CLASS[str(r.status)] || ''}`}>
                      {STATUS_LABEL[str(r.status)] || str(r.status)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {loadingDetail === id
                      ? <Loader2 className="w-4 h-4 text-orange-500 animate-spin inline" />
                      : <Eye className="w-4 h-4 text-slate-400 inline" />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-4xl max-h-[94vh] overflow-y-auto p-0 gap-0">
          <DialogHeader className="sr-only">
            <DialogTitle>{detail ? `Detail tagihan ${str(detail.noInvoice)}` : 'Detail tagihan'}</DialogTitle>
          </DialogHeader>
          {detail && <VendorInvoiceDetail detail={detail} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
