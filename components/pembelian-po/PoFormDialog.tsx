'use client';

import type { JsonObject } from '@/types/json';
import { str } from '@/types/json';
import ProductSearchSelect from '@/components/ProductSearchSelect';
import ProductStockReminder from '@/components/ProductStockReminder';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Package, Plus, Trash2 } from 'lucide-react';
import { formatArrivalLabel } from '@/lib/po-calendar';
import { toDateInputValue } from '@/lib/pembelian-po/helpers';
import { formatIDR, formatNumber } from '@/lib/format';
import { getEstimasiHargaHint, formatBeliDeltaSign } from '@/lib/po-estimasi-harga';
import { vendorDisplayName } from '@/lib/vendor-display';
import { cn } from '@/lib/utils';

type PoLineDetail = JsonObject & { product: JsonObject | null };

export type PoFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingPo: JsonObject | null;
  createDate: Date | null;
  onCreateDateChange: (date: Date | null) => void;
  lines: JsonObject[];
  lineDetails: PoLineDetail[];
  lineSummary: { rows: number; totalQty: number; totalEstimasi: number };
  catatan: string;
  onCatatanChange: (value: string) => void;
  saving: boolean;
  synced: JsonObject[];
  vendorTierMap: JsonObject;
  defaultTier: string;
  onAddLine: () => void;
  onRemoveLine: (index: number) => void;
  onSelectProduct: (index: number, id: string) => void;
  onUpdateLine: (index: number, patch: JsonObject) => void;
  onSave: () => void;
  onCancel: () => void;
};

export default function PoFormDialog({
  open,
  onOpenChange,
  editingPo,
  createDate,
  onCreateDateChange,
  lines,
  lineDetails,
  lineSummary,
  catatan,
  onCatatanChange,
  saving,
  synced,
  vendorTierMap,
  defaultTier,
  onAddLine,
  onRemoveLine,
  onSelectProduct,
  onUpdateLine,
  onSave,
  onCancel,
}: PoFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="w-5 h-5 text-orange-500" />
            {editingPo ? `Edit PO ${str(editingPo.noPO)}` : 'Buat PO Baru'}
          </DialogTitle>
          <DialogDescription>
            {editingPo
              ? `Perbarui detail PO sebelum ${str(editingPo.status) === 'PENDING_APPROVAL' ? 'disetujui' : 'diajukan/dikirim'}`
              : `Permintaan kedatangan barang: ${createDate ? formatArrivalLabel(createDate) : '—'}`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="rounded-lg border bg-slate-50/80 p-3">
            <Label className="text-xs text-slate-500 uppercase tracking-wide">Tanggal kedatangan</Label>
            <Input
              type="date"
              className="mt-1 bg-white max-w-xs"
              value={toDateInputValue(createDate)}
              onChange={(e) => onCreateDateChange(e.target.value ? new Date(`${e.target.value}T12:00:00`) : null)}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">Detail barang</Label>
              <Button variant="outline" size="sm" type="button" onClick={onAddLine}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Tambah baris
              </Button>
            </div>

            <div className="border rounded-lg overflow-hidden">
              <div className="hidden sm:grid sm:grid-cols-[2rem_minmax(0,1fr)_8.5rem_5.5rem_4.5rem_2.5rem] gap-x-3 gap-y-0 px-3 py-2 bg-slate-100 text-[11px] uppercase tracking-wide text-slate-600 font-medium items-end">
                <span>#</span>
                <span>Produk</span>
                <span className="text-right">Estimasi harga</span>
                <span className="text-right">Qty</span>
                <span className="text-center">Satuan</span>
                <span aria-hidden="true" />
              </div>
              <div className="divide-y">
                {lineDetails.map((l, i) => {
                  const hint = l.product
                    ? getEstimasiHargaHint(
                      l.product,
                      vendorTierMap as Record<string, string>,
                      defaultTier,
                      !!l.estimasiManual,
                      str(l.estimasiHarga),
                    )
                    : null;
                  return (
                    <div
                      key={i}
                      className="flex flex-col sm:grid sm:grid-cols-[2rem_minmax(0,1fr)_8.5rem_5.5rem_4.5rem_2.5rem] gap-x-3 gap-y-2 px-3 py-3 items-start"
                    >
                      <span className="text-xs text-slate-400 pt-2 hidden sm:inline">{i + 1}</span>
                      <div className="w-full min-w-0 sm:col-span-1">
                        <span className="text-xs text-slate-400 sm:hidden mb-1 block">Baris {i + 1}</span>
                        <ProductSearchSelect
                          products={synced}
                          value={str(l.localStokId)}
                          onChange={(id) => onSelectProduct(i, id)}
                          placeholder="Cari / pilih produk…"
                        />
                        {l.product && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">{str(l.product.kode)}</span>
                            {!!l.product.grup && (
                              <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">{str(l.product.grup)}</span>
                            )}
                            {vendorDisplayName(l.product) && (
                              <span className="rounded bg-orange-50 px-1.5 py-0.5 text-orange-700">{vendorDisplayName(l.product)}</span>
                            )}
                            <ProductStockReminder product={l.product} className="contents" />
                          </div>
                        )}
                      </div>
                      <div className="w-full sm:w-auto shrink-0">
                        <Label className="text-[10px] text-slate-500 uppercase sm:sr-only mb-1 block">Estimasi harga</Label>
                        <Input
                          type="number"
                          min={0}
                          step={1}
                          disabled={!l.product}
                          placeholder="Rp / satuan"
                          className="text-right h-9 tabular-nums"
                          value={str(l.estimasiHarga)}
                          onChange={(e) => onUpdateLine(i, {
                            estimasiHarga: e.target.value,
                            estimasiManual: true,
                          })}
                        />
                        {hint && (
                          <p className="mt-1 text-[10px] text-slate-500 text-right leading-snug">
                            {hint.kind === 'local' && hint.beli > 0 && (
                              <>
                                {formatIDR(hint.beli)}
                                <span className="text-orange-600 font-medium"> +10%</span>
                                {' → '}
                                <span className="font-medium text-slate-700">{formatIDR(hint.withBuffer)}</span>
                              </>
                            )}
                            {(hint.kind === 'vendor' || hint.kind === 'manual') && (
                              hint.beli > 0 && hint.deltaPct != null ? (
                                <span>
                                  <span className={cn(
                                    'font-medium',
                                    hint.deltaPct > 0 ? 'text-orange-600' : hint.deltaPct < 0 ? 'text-green-700' : 'text-slate-600',
                                  )}
                                  >
                                    {formatBeliDeltaSign(hint.deltaPct)}
                                  </span>
                                  {' dari harga beli di gudang '}
                                  <span className="font-medium text-slate-700">{formatIDR(hint.beli)}</span>
                                </span>
                              ) : (
                                <span className="text-slate-400">Belum ada harga beli di gudang</span>
                              )
                            )}
                            {hint.kind === 'local' && hint.beli <= 0 && hint.label}
                          </p>
                        )}
                      </div>
                      <div className="w-full sm:w-auto shrink-0">
                        <Label className="text-[10px] text-slate-500 uppercase sm:sr-only mb-1 block">Qty</Label>
                        <Input
                          type="number"
                          min={0.01}
                          step="any"
                          className="text-right h-9 w-full sm:w-full tabular-nums"
                          value={str(l.qty)}
                          onChange={(e) => onUpdateLine(i, { qty: e.target.value })}
                        />
                      </div>
                      <div className="w-full sm:w-auto shrink-0 flex flex-col">
                        <Label className="text-[10px] text-slate-500 uppercase sm:sr-only mb-1 block">Satuan</Label>
                        <span className={cn(
                          'inline-flex h-9 w-full items-center justify-center rounded-md border px-2 text-xs font-semibold',
                          l.product?.satuan
                            ? 'bg-white text-slate-700 border-slate-200'
                            : 'bg-slate-50 text-slate-400 border-dashed',
                        )}
                        >
                          {str(l.product?.satuan) || '—'}
                        </span>
                      </div>
                      <div className="flex justify-end sm:justify-center sm:pt-0.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 shrink-0 text-slate-400 hover:text-red-600"
                          onClick={() => onRemoveLine(i)}
                          disabled={lines.length <= 1}
                          title="Hapus baris"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {lineSummary.rows > 0 && (
              <p className="text-xs text-slate-500 text-right">
                {lineSummary.rows} baris · total {formatNumber(lineSummary.totalQty)} unit
                {lineSummary.totalEstimasi > 0 && (
                  <> · estimasi {formatIDR(lineSummary.totalEstimasi)}</>
                )}
              </p>
            )}
          </div>

          <div>
            <Label>Catatan PO</Label>
            <Input
              value={catatan}
              onChange={(e) => onCatatanChange(e.target.value)}
              placeholder="Instruksi khusus untuk vendor (opsional)"
              className="mt-1"
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" type="button" onClick={onCancel}>Batal</Button>
          <Button
            onClick={onSave}
            disabled={saving}
            className="bg-orange-500 hover:bg-orange-600"
          >
            {saving ? 'Menyimpan...' : editingPo ? 'Simpan Perubahan' : 'Simpan PO (DRAFT)'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
