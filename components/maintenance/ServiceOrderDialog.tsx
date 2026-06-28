'use client';

import type { JsonObject } from '@/types/json';
import { num } from '@/types/json';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { fetchJson } from '@/lib/fetch-json';

interface ServiceOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wr: JsonObject | null;
  onSuccess: () => void;
}

export default function ServiceOrderDialog({
  open,
  onOpenChange,
  wr,
  onSuccess,
}: ServiceOrderDialogProps) {
  const [vendorName, setVendorName] = useState('');
  const [vendorContact, setVendorContact] = useState('');
  const [scope, setScope] = useState('');
  const [estimasiBiaya, setEstimasiBiaya] = useState('');
  const [saving, setSaving] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [actualBiaya, setActualBiaya] = useState('');
  const [createdOrder, setCreatedOrder] = useState<JsonObject | null>(null);

  const reset = () => {
    setVendorName('');
    setVendorContact('');
    setScope('');
    setEstimasiBiaya('');
    setActualBiaya('');
    setCreatedOrder(null);
  };

  const createOrder = async () => {
    if (!wr?.id) return;
    if (!vendorName.trim()) { toast.error('Nama vendor/jasa wajib'); return; }
    if (!scope.trim()) { toast.error('Scope pekerjaan wajib'); return; }
    setSaving(true);
    try {
      const data = await fetchJson<JsonObject>('/api/maintenance-service-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maintenanceRequestId: wr.id,
          vendorName,
          vendorContact,
          scope,
          estimasiBiaya: num(estimasiBiaya),
        }),
      });
      setCreatedOrder(data);
      setActualBiaya(String(data.estimasiBiaya || estimasiBiaya || ''));
      toast.success(`Service order ${data.noMSO} dibuat`);
      onSuccess();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    }
    setSaving(false);
  };

  const completeOrder = async () => {
    if (!createdOrder?.id) return;
    setCompleting(true);
    try {
      const data = await fetchJson<JsonObject>(`/api/maintenance-service-orders/${createdOrder.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actualBiaya: num(actualBiaya) }),
      });
      toast.success(`Selesai — tagihan ${data.hutangNo || ''} menunggu review admin`);
      onOpenChange(false);
      reset();
      onSuccess();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    }
    setCompleting(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Jasa Perbaikan (Service Order)</DialogTitle>
        </DialogHeader>
        {!createdOrder ? (
          <div className="grid gap-3 py-2">
            <p className="text-sm text-slate-600">
              WR: <strong>{String(wr?.noWR || '')}</strong> — {String(wr?.judul || '')}
            </p>
            <div>
              <Label>Vendor / Teknisi *</Label>
              <Input value={vendorName} onChange={(e) => setVendorName(e.target.value)} />
            </div>
            <div>
              <Label>Kontak</Label>
              <Input value={vendorContact} onChange={(e) => setVendorContact(e.target.value)} />
            </div>
            <div>
              <Label>Scope pekerjaan *</Label>
              <Textarea value={scope} onChange={(e) => setScope(e.target.value)} rows={3} />
            </div>
            <div>
              <Label>Estimasi biaya (Rp)</Label>
              <Input type="number" value={estimasiBiaya} onChange={(e) => setEstimasiBiaya(e.target.value)} />
            </div>
          </div>
        ) : (
          <div className="grid gap-3 py-2">
            <p className="text-sm text-green-700 bg-green-50 rounded px-3 py-2">
              {String(createdOrder.noMSO)} dibuat untuk {String(createdOrder.vendorName)}.
              Isi biaya aktual saat pekerjaan selesai untuk generate tagihan hutang.
            </p>
            <div>
              <Label>Biaya aktual (Rp) *</Label>
              <Input type="number" value={actualBiaya} onChange={(e) => setActualBiaya(e.target.value)} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Tutup</Button>
          {!createdOrder ? (
            <Button onClick={() => void createOrder()} disabled={saving}>
              {saving ? 'Menyimpan...' : 'Buat Service Order'}
            </Button>
          ) : (
            <Button onClick={() => void completeOrder()} disabled={completing}>
              {completing ? 'Memproses...' : 'Selesai & Buat Tagihan'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
