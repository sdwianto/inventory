'use client';

import type { JsonObject } from '@/types/json';
import { str, num, asArray, asObject } from '@/types/json';
import { useMemo, useState } from 'react';
import VendorInvoiceDocument from '@/components/VendorInvoiceDocument';
import VendorInvoiceThermal from '@/components/VendorInvoiceThermal';
import PrintPortal, { printReceipt } from '@/components/PrintPortal';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { printDocument } from '@/lib/doc-print';
import { formatIDR } from '@/lib/format';
import { Check, CircleDollarSign, Loader2, Printer, Receipt, Undo2, X } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

const PRINT_ID = 'vendor-invoice-a4-print';

type LineDraft = {
  lineId: string;
  selected: boolean;
  qty: string;
  hargaBenar: string;
};

export default function VendorInvoiceDetail({
  detail,
  acting = '',
  overrideMatch = false,
  onOverrideMatchChange,
  onApprove,
  onReject,
  onMarkPaid,
  onDetailRefresh,
}: {
  detail: JsonObject | null;
  acting?: string;
  overrideMatch?: boolean;
  onOverrideMatchChange?: (v: boolean) => void;
  onApprove?: () => void;
  onReject?: () => void;
  onMarkPaid?: () => void;
  /** Dipanggil setelah draft CN/DN koreksi harga berhasil dibuat. */
  onDetailRefresh?: () => void;
}) {
  const [printing, setPrinting] = useState(false);
  const [thermalPrint, setThermalPrint] = useState(false);
  const [a4Print, setA4Print] = useState(false);
  const [priceAdjOpen, setPriceAdjOpen] = useState(false);
  const [lineDrafts, setLineDrafts] = useState<LineDraft[]>([]);
  const [submittingCn, setSubmittingCn] = useState(false);
  const [submittingDn, setSubmittingDn] = useState(false);
  const [catatan, setCatatan] = useState('');

  const rawItems = useMemo(() => {
    const items = asArray(detail?.items);
    return items.filter((raw) => {
      const it = raw as JsonObject;
      return Boolean(str(it.lineId)) && (num(it.qty) || 0) > 0;
    }) as JsonObject[];
  }, [detail?.items]);

  if (!detail) return null;

  const approval = str(detail.approvalStatus || detail.status);
  const markingPaid = typeof acting === 'string' && acting.startsWith('paid');
  const noInvoice = str(detail.noInvoice);
  const vendorTenantId = str(detail.vendorTenantId);
  const vendorName = str(
    asObject(detail.vendor).companyName
      || detail.supplierName
      || vendorTenantId
      || 'Vendor',
  );

  const openPriceAdj = () => {
    setLineDrafts(rawItems.map((it) => ({
      lineId: str(it.lineId),
      selected: false,
      qty: String(num(it.qty) || 1),
      hargaBenar: '',
    })));
    setCatatan(`Koreksi harga ${noInvoice}`);
    setPriceAdjOpen(true);
  };

  const patchLine = (lineId: string, patch: Partial<LineDraft>) => {
    setLineDrafts((prev) => prev.map((row) => (row.lineId === lineId ? { ...row, ...patch } : row)));
  };

  const selectedPreview = lineDrafts.flatMap((row) => {
    if (!row.selected) return [];
    const inv = rawItems.find((it) => str(it.lineId) === row.lineId);
    if (!inv) return [];
    const hargaInvoice = num(inv.harga) || 0;
    const hargaBenar = parseInt(row.hargaBenar || '0', 10) || 0;
    const qty = parseFloat(row.qty || '0') || 0;
    const signed = hargaInvoice - hargaBenar;
    const kind = !row.hargaBenar.trim()
      ? 'empty' as const
      : signed > 0
        ? 'over' as const
        : signed < 0
          ? 'under' as const
          : 'same' as const;
    const absUnit = Math.abs(signed);
    return [{
      lineId: row.lineId,
      kode: str(inv.kode),
      nama: str(inv.nama),
      hargaInvoice,
      hargaBenar,
      qty,
      kind,
      credit: kind === 'over' ? absUnit * qty : 0,
      shortfall: kind === 'under' ? absUnit * qty : 0,
    }];
  });
  const overchargeLines = selectedPreview.filter((r) => r.kind === 'over' && r.qty > 0);
  const underchargeLines = selectedPreview.filter((r) => r.kind === 'under' && r.qty > 0);
  const creditTotal = overchargeLines.reduce((s, r) => s + r.credit, 0);
  const shortfallTotal = underchargeLines.reduce((s, r) => s + r.shortfall, 0);

  const submitPriceCn = async () => {
    const hutangId = str(detail.id);
    if (!hutangId) return;
    const items = overchargeLines.map((r) => ({
      lineId: r.lineId,
      qty: r.qty,
      hargaBenar: r.hargaBenar,
    }));
    if (!items.length) {
      toast.error('Pilih baris overcharge: harga benar harus lebih rendah dari harga tagihan');
      return;
    }
    setSubmittingCn(true);
    try {
      const res = await fetch(`/api/hutang/${encodeURIComponent(hutangId)}/request-price-cn?tenantId=${encodeURIComponent(str(detail.tenantId) || '')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          tenantId: str(detail.tenantId) || undefined,
          items,
          catatan: catatan || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(str(json.error, `Gagal (${res.status})`));
      const cn = asObject(json.priceCn);
      toast.success(
        `Draft CN ${str(cn.noCN) || str(cn.creditNoteId)} dibuat di Sales (${formatIDR(num(cn.amount))}) — vendor tinggal post`,
      );
      if (underchargeLines.length) {
        toast.message(
          `${underchargeLines.length} baris undercharge belum dikirim — gunakan tombol draft DN`,
        );
      }
      if (!underchargeLines.length) setPriceAdjOpen(false);
      onDetailRefresh?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmittingCn(false);
    }
  };

  const submitPriceDn = async () => {
    const hutangId = str(detail.id);
    if (!hutangId) return;
    const items = underchargeLines.map((r) => ({
      lineId: r.lineId,
      qty: r.qty,
      hargaBenar: r.hargaBenar,
    }));
    if (!items.length) {
      toast.error('Pilih baris undercharge: harga benar harus lebih tinggi dari harga tagihan');
      return;
    }
    setSubmittingDn(true);
    try {
      const res = await fetch(`/api/hutang/${encodeURIComponent(hutangId)}/request-price-dn?tenantId=${encodeURIComponent(str(detail.tenantId) || '')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          tenantId: str(detail.tenantId) || undefined,
          items,
          catatan: catatan || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(str(json.error, `Gagal (${res.status})`));
      const dn = asObject(json.priceDn);
      toast.success(
        `Draft DN ${str(dn.noDN) || str(dn.debitNoteId)} dibuat di Sales (${formatIDR(num(dn.amount))}) — vendor tinggal post`,
      );
      if (overchargeLines.length) {
        toast.message(
          `${overchargeLines.length} baris overcharge belum dikirim — gunakan tombol draft CN`,
        );
      }
      if (!overchargeLines.length) setPriceAdjOpen(false);
      onDetailRefresh?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmittingDn(false);
    }
  };

  const handlePrintA4 = async () => {
    setPrinting(true);
    setA4Print(true);
    try {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 250)));
      await printDocument(PRINT_ID);
    } finally {
      setA4Print(false);
      setPrinting(false);
    }
  };

  const handlePrintThermal = async () => {
    setPrinting(true);
    setThermalPrint(true);
    try {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 200)));
      await printReceipt(450);
    } finally {
      setThermalPrint(false);
      setPrinting(false);
    }
  };

  return (
    <div className="text-sm">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-white/95 backdrop-blur px-4 py-3 no-print">
        <div className="min-w-0">
          <p className="text-xs text-slate-500">Tagihan vendor</p>
          <p className="font-mono font-semibold text-orange-600 truncate">{noInvoice}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={printing} onClick={handlePrintThermal}>
            {printing && thermalPrint ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Receipt className="w-4 h-4 mr-1" />}
            Thermal
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={printing} onClick={handlePrintA4}>
            {printing && !thermalPrint ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Printer className="w-4 h-4 mr-1" />}
            A4
          </Button>
        </div>
      </div>

      <div className="px-4 py-4 md:px-6">
        {detail.matchStatus === 'EXCEPTION' && (
          <div className="p-3 mb-4 bg-amber-50 border border-amber-200 rounded text-amber-900 text-xs no-print">
            {str(detail.matchError, '3-way match exception')}
            {approval === 'PENDING_REVIEW' && onOverrideMatchChange && (
              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={overrideMatch}
                  onChange={(e) => onOverrideMatchChange(e.target.checked)}
                />
                Setujui dengan override (sudah diverifikasi manual)
              </label>
            )}
          </div>
        )}

        <VendorInvoiceDocument detail={detail} className="mx-auto" />

        {asArray(detail.creditNotes).length > 0 && (
          <div className="mt-4 border rounded p-3 no-print">
            <p className="text-xs font-semibold uppercase text-slate-500 mb-2">Credit note / retur</p>
            <ul className="space-y-1 text-xs">
              {asArray(detail.creditNotes).map((raw, i) => {
                const cn = raw as JsonObject;
                const fromRtv = str(cn.source) === 'inventory_return' || Boolean(str(cn.noReturn));
                return (
                <li key={str(cn.creditNoteId) || i} className="flex flex-wrap gap-x-3 gap-y-0.5">
                  <span className="font-mono">{str(cn.noCN) || str(cn.creditNoteId)}</span>
                  {str(cn.noReturn) ? <span>RTV {str(cn.noReturn)}</span> : null}
                  {cn.amount != null ? <span>{formatIDR(num(cn.amount))}</span> : null}
                  {fromRtv
                    ? (
                      <span className="text-orange-700">
                        Retur Inventory{str(cn.noReturn) ? ` (${str(cn.noReturn)})` : ''}
                      </span>
                    )
                    : <span className="text-slate-600">Koreksi harga / CN finansial</span>}
                </li>
                );
              })}
            </ul>
          </div>
        )}

        {asArray(detail.debitNotes).length > 0 && (
          <div className="mt-4 border rounded p-3 no-print">
            <p className="text-xs font-semibold uppercase text-slate-500 mb-2">Debit note</p>
            <ul className="space-y-1 text-xs">
              {asArray(detail.debitNotes).map((raw, i) => {
                const dn = raw as JsonObject;
                return (
                  <li key={str(dn.debitNoteId) || i} className="flex flex-wrap gap-x-3 gap-y-0.5">
                    <span className="font-mono">{str(dn.noDN) || str(dn.debitNoteId)}</span>
                    {dn.amount != null ? <span>{formatIDR(num(dn.amount))}</span> : null}
                    <span className="text-amber-800">Koreksi undercharge / DN finansial</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {approval !== 'REJECTED' && (
          <div className="mt-4 p-3 rounded border border-slate-200 bg-slate-50 text-xs text-slate-700 no-print space-y-1">
            <p className="font-medium text-slate-800">Salah harga vs retur fisik</p>
            <p>
              Overcharge → draft <span className="font-medium">Credit Note</span>; undercharge → draft{' '}
              <span className="font-medium">Debit Note</span> (barang tetap di gudang). Stok tidak bergerak.
            </p>
            <p>
              <span className="font-medium">Buat Retur</span> hanya jika barang benar-benar keluar gudang.
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-4 mt-4 border-t no-print justify-end">
          {approval !== 'REJECTED' && (
            <Button type="button" variant="outline" onClick={openPriceAdj} disabled={!rawItems.length}>
              <CircleDollarSign className="w-4 h-4 mr-1" /> Koreksi harga
            </Button>
          )}
          {approval !== 'REJECTED' && str(detail.id) && (
            <Button asChild variant="outline" title="Retur fisik (stok keluar)">
              <Link href={`/retur-vendor?hutangId=${encodeURIComponent(str(detail.id))}`}>
                <Undo2 className="w-4 h-4 mr-1" /> Buat Retur
                <span className="ml-1 text-[10px] font-normal text-slate-500 hidden sm:inline">
                  (fisik)
                </span>
              </Link>
            </Button>
          )}
          {approval === 'PENDING_REVIEW' && (
            <>
              <Button onClick={onApprove} disabled={acting === 'approve'} className="bg-green-600 hover:bg-green-700">
                <Check className="w-4 h-4 mr-1" />
                {acting === 'approve' ? '...' : 'Setujui'}
              </Button>
              <Button variant="outline" onClick={onReject} disabled={acting === 'reject'}>
                <X className="w-4 h-4 mr-1" /> Tolak
              </Button>
            </>
          )}
          {approval === 'APPROVED' && onMarkPaid && (
            <Button
              variant="outline"
              onClick={onMarkPaid}
              disabled={markingPaid}
              className="border-green-600 text-green-700 hover:bg-green-50"
            >
              <Check className="w-4 h-4 mr-1" />
              {markingPaid ? '...' : 'Tandai Lunas (bayar diluar sistem)'}
            </Button>
          )}
        </div>
      </div>

      <Dialog open={priceAdjOpen} onOpenChange={setPriceAdjOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto no-print">
          <DialogHeader>
            <DialogTitle>Koreksi harga → draft CN / DN Sales</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-slate-700 space-y-3">
            <p className="text-xs text-slate-600">
              Pilih baris yang salah harga, isi <span className="font-medium">harga benar</span>.
              {' '}<span className="font-medium">Tagihan &gt; benar</span> → draft Credit Note (overcharge).
              {' '}<span className="font-medium">Benar &gt; tagihan</span> → draft Debit Note (undercharge).
              Stok tidak keluar.
            </p>
            <dl className="rounded border bg-slate-50 p-3 text-xs space-y-1 font-mono">
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500 font-sans">Invoice</dt>
                <dd>{noInvoice || '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500 font-sans">Vendor</dt>
                <dd className="text-right">{vendorName}</dd>
              </div>
            </dl>

            {!rawItems.length ? (
              <p className="text-xs text-amber-700">Tidak ada baris dengan lineId/qty untuk dikoreksi.</p>
            ) : (
              <div className="border rounded overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-100 text-slate-600">
                    <tr>
                      <th className="px-2 py-1.5 text-left w-8" />
                      <th className="px-2 py-1.5 text-left">Item</th>
                      <th className="px-2 py-1.5 text-right">Harga tagihan</th>
                      <th className="px-2 py-1.5 text-right">Qty</th>
                      <th className="px-2 py-1.5 text-right">Harga benar</th>
                      <th className="px-2 py-1.5 text-right">Selisih</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rawItems.map((it) => {
                      const lineId = str(it.lineId);
                      const draft = lineDrafts.find((d) => d.lineId === lineId);
                      const hargaInvoice = num(it.harga) || 0;
                      const hargaBenar = parseInt(draft?.hargaBenar || '0', 10) || 0;
                      const qty = parseFloat(draft?.qty || '0') || 0;
                      const signed = draft?.selected && draft.hargaBenar.trim()
                        ? hargaInvoice - hargaBenar
                        : 0;
                      const absAmt = Math.abs(signed) * qty;
                      return (
                        <tr key={lineId} className="border-t">
                          <td className="px-2 py-1.5">
                            <input
                              type="checkbox"
                              checked={Boolean(draft?.selected)}
                              onChange={(e) => patchLine(lineId, { selected: e.target.checked })}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="font-mono text-[11px] text-orange-700">{str(it.kode)}</div>
                            <div className="text-slate-600 truncate max-w-[160px]">{str(it.nama)}</div>
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{formatIDR(hargaInvoice)}</td>
                          <td className="px-2 py-1.5 text-right">
                            <Input
                              className="h-7 w-16 text-right ml-auto"
                              disabled={!draft?.selected}
                              value={draft?.qty || ''}
                              onChange={(e) => patchLine(lineId, { qty: e.target.value })}
                            />
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <Input
                              className="h-7 w-24 text-right ml-auto"
                              disabled={!draft?.selected}
                              placeholder="0"
                              value={draft?.hargaBenar || ''}
                              onChange={(e) => patchLine(lineId, { hargaBenar: e.target.value })}
                            />
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {!draft?.selected || !draft.hargaBenar.trim() || qty <= 0 ? (
                              <span className="text-slate-400">—</span>
                            ) : signed > 0 ? (
                              <span className="text-emerald-700">Kredit {formatIDR(absAmt)}</span>
                            ) : signed < 0 ? (
                              <span className="text-amber-700" title="Undercharge — Debit Note">
                                Kurang {formatIDR(absAmt)}
                              </span>
                            ) : (
                              <span className="text-slate-400">0</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div>
              <label className="text-xs text-slate-500">Catatan (ke Sales)</label>
              <Input
                className="mt-1"
                value={catatan}
                onChange={(e) => setCatatan(e.target.value)}
                placeholder="Alasan koreksi harga"
              />
            </div>

            <div className="text-xs space-y-1">
              <p className="font-medium text-slate-800">
                Estimasi kredit CN: {formatIDR(creditTotal)}
                {overchargeLines.length ? ` · ${overchargeLines.length} baris overcharge` : ''}
              </p>
              {shortfallTotal > 0 ? (
                <p className="font-medium text-amber-800">
                  Estimasi debit DN: {formatIDR(shortfallTotal)} · {underchargeLines.length} baris undercharge
                </p>
              ) : null}
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0 flex-wrap">
            <Button type="button" variant="outline" onClick={() => setPriceAdjOpen(false)} disabled={submittingCn || submittingDn}>
              Batal
            </Button>
            <Button
              type="button"
              onClick={() => void submitPriceCn()}
              disabled={submittingCn || submittingDn || creditTotal <= 0}
              className="bg-orange-600 hover:bg-orange-700"
            >
              {submittingCn ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <CircleDollarSign className="w-4 h-4 mr-1" />}
              Buat draft CN
            </Button>
            <Button
              type="button"
              onClick={() => void submitPriceDn()}
              disabled={submittingCn || submittingDn || shortfallTotal <= 0}
              className="bg-amber-700 hover:bg-amber-800"
            >
              {submittingDn ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <CircleDollarSign className="w-4 h-4 mr-1" />}
              Buat draft DN
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {thermalPrint && (
        <PrintPortal>
          <VendorInvoiceThermal detail={detail} />
        </PrintPortal>
      )}

      {a4Print && (
        <PrintPortal>
          <div className="doc-print-host">
            <VendorInvoiceDocument detail={detail} printId={PRINT_ID} />
          </div>
        </PrintPortal>
      )}
    </div>
  );
}
