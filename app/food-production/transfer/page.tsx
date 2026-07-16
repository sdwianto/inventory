'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { getUser } from '@/lib/auth-client';
import { useConfirm } from '@/components/ConfirmProvider';
import { ArrowLeftRight, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  XFER_STATUS_LABELS,
  XFER_UI_STATUS_NEXT,
  type KitchenTransferStatus,
} from '@/lib/food-production/kitchen-transfer';

const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface KitchenOpt {
  id: string;
  nama: string;
  kitchenType?: string;
  defaultWarehouseKode: string;
}

interface ProductOpt {
  id: string;
  kode?: string;
  nama?: string;
  satuan?: string;
}

interface LineDraft {
  productId: string;
  qty: string;
}

interface XferRow {
  id: string;
  noDokumen: string;
  tanggal: string;
  fromKitchenNama?: string;
  toKitchenNama?: string;
  allocationOnly?: boolean;
  status: KitchenTransferStatus;
  summary?: { lineCount: number; qtyTotal: number };
}

export default function KitchenTransferPage() {
  const confirm = useConfirm();
  const canManage = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return MANAGE_ROLES.has(role);
  }, []);

  const [rows, setRows] = useState<XferRow[]>([]);
  const [kitchens, setKitchens] = useState<KitchenOpt[]>([]);
  const [products, setProducts] = useState<ProductOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [fromKitchenId, setFromKitchenId] = useState('');
  const [toKitchenId, setToKitchenId] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ productId: '', qty: '1' }]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [xRes, kRes, pRes] = await Promise.all([
        fetch('/api/kitchen-transfers', { headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() } }),
        fetch('/api/kitchens?aktif=1', { headers: { ...actingTenantHeaders() } }),
        fetch('/api/products?limit=100&enrichUom=0', { headers: { ...actingTenantHeaders() } }),
      ]);
      const xData = await xRes.json();
      const kData = await kRes.json();
      const pData = await pRes.json();
      if (!xRes.ok) throw new Error(xData?.error || 'Gagal memuat');
      setRows(Array.isArray(xData) ? xData : []);
      setKitchens(Array.isArray(kData) ? kData : []);
      const plist = Array.isArray(pData) ? pData : (pData?.items || pData?.data || []);
      setProducts(Array.isArray(plist) ? plist : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKitchen = () => { void load(); };
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  function openCreate() {
    setFromKitchenId('');
    setToKitchenId('');
    setLines([{ productId: '', qty: '1' }]);
    setOpen(true);
  }

  async function create() {
    if (!fromKitchenId || !toKitchenId) {
      toast.error('Lengkapi dapur asal dan tujuan');
      return;
    }
    const payloadLines = lines
      .filter((l) => l.productId && Number(l.qty) > 0)
      .map((l) => {
        const product = products.find((p) => p.id === l.productId);
        return {
          productId: l.productId,
          productKode: product?.kode,
          productNama: product?.nama,
          satuan: product?.satuan,
          qty: Number(l.qty),
        };
      });
    if (!payloadLines.length) {
      toast.error('Minimal satu baris produk');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/kitchen-transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          fromKitchenId,
          toKitchenId,
          lines: payloadLines,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal membuat');
      toast.success(`XFR ${data.noDokumen}${data.allocationOnly ? ' (alokasi)' : ''}`);
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function advance(row: XferRow) {
    const next = XFER_UI_STATUS_NEXT[row.status];
    if (!next) return;
    const res = await fetch(`/api/kitchen-transfers/${row.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
      body: JSON.stringify({ status: next }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal');
      return;
    }
    toast.success(`Status → ${XFER_STATUS_LABELS[next]}`);
    await load();
  }

  async function cancelXfer(row: XferRow) {
    const okConfirm = await confirm({
      title: 'Batalkan transfer?',
      description: row.noDokumen,
      confirmText: 'Batalkan',
      variant: 'destructive',
    });
    if (!okConfirm) return;
    const res = await fetch(`/api/kitchen-transfers/${row.id}`, {
      method: 'DELETE',
      headers: { ...actingTenantHeaders() },
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal');
      return;
    }
    toast.success('Transfer dibatalkan');
    await load();
  }

  const centrals = kitchens.filter((k) => k.kitchenType === 'CENTRAL');
  const satellites = kitchens.filter((k) => k.kitchenType !== 'CENTRAL');

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <KitchenScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5" />
            Transfer Antar Dapur
          </h1>
          <p className="text-sm text-muted-foreground">
            Distribusi Central → Satelit (XFR). Gudang sama = alokasi dokumen.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat
          </Button>
          {canManage && (
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1" /> Baru
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">No XFR</th>
              <th className="text-left p-3">Dari → Ke</th>
              <th className="text-left p-3">Tanggal</th>
              <th className="text-left p-3">Mode</th>
              <th className="text-left p-3">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Belum ada transfer</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-3 font-mono text-xs">{row.noDokumen}</td>
                <td className="p-3">{row.fromKitchenNama} → {row.toKitchenNama}</td>
                <td className="p-3">{row.tanggal}</td>
                <td className="p-3 text-xs">{row.allocationOnly ? 'Alokasi' : 'Stok'}</td>
                <td className="p-3">{XFER_STATUS_LABELS[row.status]}</td>
                <td className="p-3 text-right space-x-1">
                  {canManage && XFER_UI_STATUS_NEXT[row.status] && (
                    <Button size="sm" variant="outline" onClick={() => void advance(row)}>
                      {XFER_UI_STATUS_NEXT[row.status] === 'COMPLETED' ? 'Selesai' : 'Lanjut'}
                    </Button>
                  )}
                  {canManage && row.status !== 'COMPLETED' && row.status !== 'CANCELLED' && (
                    <Button size="sm" variant="ghost" onClick={() => void cancelXfer(row)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Transfer / Distribusi</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>Dari dapur {centrals.length ? '(Central disarankan)' : ''}</Label>
              <select className="w-full h-10 border rounded-md px-2 text-sm" value={fromKitchenId} onChange={(e) => setFromKitchenId(e.target.value)}>
                <option value="">—</option>
                {(centrals.length ? centrals : kitchens).map((k) => (
                  <option key={k.id} value={k.id}>{k.nama} · {k.defaultWarehouseKode}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Ke dapur satelit</Label>
              <select className="w-full h-10 border rounded-md px-2 text-sm" value={toKitchenId} onChange={(e) => setToKitchenId(e.target.value)}>
                <option value="">—</option>
                {(satellites.length ? satellites : kitchens).map((k) => (
                  <option key={k.id} value={k.id}>{k.nama} · {k.defaultWarehouseKode}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Baris produk</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setLines((prev) => [...prev, { productId: '', qty: '1' }])}
                >
                  <Plus className="h-3 w-3 mr-1" /> Baris
                </Button>
              </div>
              {lines.map((line, idx) => (
                <div key={idx} className="flex gap-2 items-end">
                  <div className="flex-1 space-y-1">
                    <select
                      className="w-full h-10 border rounded-md px-2 text-sm"
                      value={line.productId}
                      onChange={(e) => setLines((prev) => prev.map((l, i) => (
                        i === idx ? { ...l, productId: e.target.value } : l
                      )))}
                    >
                      <option value="">—</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>{p.kode} · {p.nama}</option>
                      ))}
                    </select>
                  </div>
                  <div className="w-24 space-y-1">
                    <Input
                      type="number"
                      value={line.qty}
                      onChange={(e) => setLines((prev) => prev.map((l, i) => (
                        i === idx ? { ...l, qty: e.target.value } : l
                      )))}
                    />
                  </div>
                  {lines.length > 1 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Batal</Button>
            <Button onClick={() => void create()} disabled={saving}>
              {saving ? 'Menyimpan…' : 'Buat XFR'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
