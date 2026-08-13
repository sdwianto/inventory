'use client';

import type { JsonObject } from '@/types/json';
import { asArray, asObject, num, str } from '@/types/json';
import { useCallback, useEffect, useMemo, useState } from 'react';
import HutangVendorPrintDocument from '@/components/HutangVendorPrintDocument';
import PrintPortal from '@/components/PrintPortal';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { printDocument } from '@/lib/doc-print';
import { fetchJson } from '@/lib/fetch-json';
import { formatIDR } from '@/lib/format';
import { buildHutangPrintItemRows, hutangHasLineItems } from '@/lib/hutang-print-items';
import { useTenantSettings } from '@/lib/tenant-client';
import { ClipboardList, Loader2, Printer } from 'lucide-react';
import { toast } from 'sonner';

const PRINT_ID = 'hutang-vendor-print';

function vendorKey(row: JsonObject): string {
  return str(row.vendorTenantId) || str(row.supplierName) || str(asObject(row.vendorBillingSnapshot).companyName) || '—';
}

function vendorLabel(row: JsonObject): string {
  return str(row.supplierName) || str(asObject(row.vendorBillingSnapshot).companyName) || str(row.vendorTenantId) || '—';
}

function toDayKey(raw: unknown): string {
  if (!raw) return '';
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function mergeDetailIntoRow(base: JsonObject, detail: JsonObject): JsonObject {
  const itemsFull = asArray(detail.itemsFull);
  const items = itemsFull.length ? itemsFull : asArray(detail.items);
  return {
    ...base,
    ...detail,
    items,
    itemsFull: itemsFull.length ? itemsFull : items,
    tanggalPermintaanKirim: detail.tanggalPermintaanKirim || base.tanggalPermintaanKirim,
    tanggalAktualKirim: detail.tanggalAktualKirim || base.tanggalAktualKirim || detail.tanggal || base.tanggal,
  };
}

export default function HutangVendorPrintPanel({
  open,
  onOpenChange,
  rows,
  tabLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: JsonObject[];
  tabLabel?: string;
}) {
  const settings = useTenantSettings();
  const [filterAll, setFilterAll] = useState(true);
  const [filterTenant, setFilterTenant] = useState(false);
  const [filterDate, setFilterDate] = useState(false);
  const [selectedVendors, setSelectedVendors] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [printing, setPrinting] = useState(false);
  const [loadingItems, setLoadingItems] = useState(false);
  const [detailById, setDetailById] = useState<Record<string, JsonObject>>({});

  const vendorOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) {
      const key = vendorKey(row);
      if (!map.has(key)) map.set(key, vendorLabel(row));
    }
    return [...map.entries()]
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'id'));
  }, [rows]);

  const filteredRows = useMemo(() => {
    let list = rows;
    if (!filterAll && filterTenant) {
      if (!selectedVendors.length) return [];
      const set = new Set(selectedVendors);
      list = list.filter((r) => set.has(vendorKey(r)));
    }
    if (!filterAll && filterDate) {
      if (!dateFrom && !dateTo) return [];
      list = list.filter((r) => {
        const key = toDayKey(r.tanggalAktualKirim || r.tanggal || r.tanggalPermintaanKirim);
        if (!key) return false;
        if (dateFrom && key < dateFrom) return false;
        if (dateTo && key > dateTo) return false;
        return true;
      });
    }
    return list.map((r) => {
      const id = str(r.id);
      const detail = id ? detailById[id] : undefined;
      return detail ? mergeDetailIntoRow(r, detail) : r;
    });
  }, [rows, filterAll, filterTenant, filterDate, selectedVendors, dateFrom, dateTo, detailById]);

  const loadMissingItems = useCallback(async (list: JsonObject[]) => {
    const missingIds = list
      .map((r) => str(r.id))
      .filter((id) => {
        if (!id) return false;
        const cached = detailById[id];
        if (cached && hutangHasLineItems(cached)) return false;
        const row = list.find((r) => str(r.id) === id);
        return row ? !hutangHasLineItems(row) : true;
      });
    const uniqueMissing = [...new Set(missingIds)];
    if (!uniqueMissing.length) return;

    setLoadingItems(true);
    try {
      const loaded = await Promise.all(
        uniqueMissing.map(async (id) => {
          try {
            const data = await fetchJson<JsonObject>(`/api/hutang/${id}`);
            return { id, data };
          } catch {
            return { id, data: null };
          }
        }),
      );
      setDetailById((prev) => {
        const next = { ...prev };
        for (const { id, data } of loaded) {
          if (data) next[id] = data;
        }
        return next;
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat detail item');
    } finally {
      setLoadingItems(false);
    }
  }, [detailById]);

  const filteredIdsKey = filteredRows.map((r) => str(r.id)).join(',');

  useEffect(() => {
    if (!open || !filteredIdsKey) return;
    void loadMissingItems(filteredRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by filtered id set
  }, [open, filteredIdsKey]);

  const itemCount = useMemo(
    () => buildHutangPrintItemRows(filteredRows).length,
    [filteredRows],
  );

  const totalNilai = useMemo(
    () => filteredRows.reduce((s, r) => s + num(r.total), 0),
    [filteredRows],
  );

  const subtitle = [
    tabLabel ? `Status: ${tabLabel}` : null,
    filterAll || (!filterTenant && !filterDate) ? 'Semua data tab' : null,
    !filterAll && filterTenant && selectedVendors.length
      ? `Vendor: ${selectedVendors.length} dipilih`
      : null,
    !filterAll && filterDate && (dateFrom || dateTo)
      ? `Tanggal: ${dateFrom || '…'} s/d ${dateTo || '…'}`
      : null,
  ].filter(Boolean).join(' · ');

  const toggleVendor = (key: string) => {
    setSelectedVendors((prev) => (
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    ));
  };

  const handlePrint = async () => {
    if (!filteredRows.length) {
      toast.message('Tidak ada data untuk dicetak');
      return;
    }
    setPrinting(true);
    try {
      await loadMissingItems(filteredRows);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 250)));
      await printDocument(PRINT_ID, 300, `Tagihan Vendor - ${new Date().toLocaleDateString('id-ID')}`);
    } finally {
      setPrinting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[98vw] w-full xl:max-w-[min(1600px,98vw)] h-[92vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-2 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-orange-500" />
            Cetak Tagihan Vendor
          </DialogTitle>
          <p className="text-xs text-slate-500 font-normal">
            Detail item barang per invoice — format seperti Acuan Pengadaan di Sales Order
          </p>
        </DialogHeader>

        <div className="px-4 py-2 border-b bg-slate-50 flex flex-wrap items-start gap-4 shrink-0">
          <div className="space-y-1.5 min-w-[160px]">
            <Label className="text-[11px] text-slate-500">Filter tampilan</Label>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={filterAll}
                onChange={(e) => {
                  const on = e.target.checked;
                  setFilterAll(on);
                  if (on) {
                    setFilterTenant(false);
                    setFilterDate(false);
                  }
                }}
                className="rounded"
              />
              Semua (All)
            </label>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={filterTenant}
                onChange={(e) => {
                  const on = e.target.checked;
                  setFilterTenant(on);
                  if (on) setFilterAll(false);
                }}
                className="rounded"
              />
              Berdasarkan tenant / vendor
            </label>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={filterDate}
                onChange={(e) => {
                  const on = e.target.checked;
                  setFilterDate(on);
                  if (on) setFilterAll(false);
                }}
                className="rounded"
              />
              Berdasarkan tanggal
            </label>
          </div>

          {filterTenant && !filterAll && (
            <div className="min-w-[200px] max-w-sm flex-1">
              <Label className="text-[11px] text-slate-500">Checklist vendor</Label>
              <div className="mt-1 max-h-28 overflow-y-auto rounded border bg-white p-2 space-y-1">
                {vendorOptions.map((v) => (
                  <label key={v.key} className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedVendors.includes(v.key)}
                      onChange={() => toggleVendor(v.key)}
                      className="rounded"
                    />
                    <span className="truncate">{v.label}</span>
                  </label>
                ))}
                {!vendorOptions.length && (
                  <p className="text-xs text-slate-400">Tidak ada vendor di daftar</p>
                )}
              </div>
            </div>
          )}

          {filterDate && !filterAll && (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label className="text-[11px] text-slate-500">Dari</Label>
                <Input type="date" className="h-8 w-[150px]" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
              </div>
              <div>
                <Label className="text-[11px] text-slate-500">Sampai</Label>
                <Input type="date" className="h-8 w-[150px]" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
              </div>
            </div>
          )}

          <div className="ml-auto text-right text-xs text-slate-600 pb-0.5">
            <div className="font-medium">
              {filteredRows.length} invoice · {itemCount} baris barang · {formatIDR(totalNilai)}
            </div>
            {loadingItems && (
              <div className="text-[10px] text-slate-400 flex items-center justify-end gap-1 mt-0.5">
                <Loader2 className="w-3 h-3 animate-spin" /> Memuat detail item…
              </div>
            )}
            <Button
              size="sm"
              className="mt-1.5 bg-orange-500 hover:bg-orange-600"
              disabled={!filteredRows.length || printing || loadingItems}
              onClick={() => void handlePrint()}
            >
              {printing ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Printer className="w-3.5 h-3.5 mr-1" />}
              Cetak
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-slate-100 p-3">
          <div className="shadow-lg rounded-sm overflow-hidden bg-white mx-auto w-full max-w-[min(100%,320mm)]">
            {loadingItems && !filteredRows.some(hutangHasLineItems) ? (
              <div className="flex items-center justify-center gap-2 text-slate-400 py-16">
                <Loader2 className="w-5 h-5 animate-spin" /> Memuat detail barang…
              </div>
            ) : (
              <HutangVendorPrintDocument
                rows={filteredRows}
                settings={settings as JsonObject | null}
                subtitle={subtitle}
                showVendorColumn
                className="p-3 md:p-4"
                printId={`${PRINT_ID}-preview`}
              />
            )}
          </div>
        </div>

        {open && (
          <PrintPortal>
            <div className="doc-print-host">
              <HutangVendorPrintDocument
                rows={filteredRows}
                settings={settings as JsonObject | null}
                subtitle={subtitle}
                showVendorColumn
                printId={PRINT_ID}
              />
            </div>
          </PrintPortal>
        )}
      </DialogContent>
    </Dialog>
  );
}
