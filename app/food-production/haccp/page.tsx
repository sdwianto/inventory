'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { getUser } from '@/lib/auth-client';
import PhotoUploadField from '@/components/maintenance/PhotoUploadField';
import { ShieldCheck, Plus, RefreshCw, Eye } from 'lucide-react';
import {
  HACCP_STATUS_LABELS,
  HACCP_CATEGORY_LABELS,
  HACCP_UI_STATUS_NEXT,
  isHaccpEditable,
  type HaccpResultStatus,
  type HaccpItemResult,
} from '@/lib/food-production/haccp';

const OPS_WRITE = new Set(['GUDANG', 'ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);
const MANAGE = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface Template {
  id: string;
  kode: string;
  nama: string;
  category: keyof typeof HACCP_CATEGORY_LABELS;
  items: Array<{ key: string; label: string; required?: boolean; needsPhoto?: boolean }>;
}

interface BatchOpt {
  id: string;
  batchNo: string;
  finishedGoodNama?: string;
  kitchenNama?: string;
}

interface HaccpRow {
  id: string;
  noDokumen: string;
  templateKode?: string;
  templateNama?: string;
  category: keyof typeof HACCP_CATEGORY_LABELS;
  productionBatchId: string;
  batchNo?: string;
  tanggal: string;
  status: HaccpResultStatus;
  summary?: { passCount: number; failCount: number; photoCount: number };
  items: Array<{ key: string; label: string; result: HaccpItemResult; note?: string }>;
  evidenceUrls?: string[];
}

export default function HaccpPage() {
  const role = useMemo(
    () => String((getUser() as { role?: string } | null)?.role || ''),
    [],
  );
  const canLog = OPS_WRITE.has(role);
  const canManage = MANAGE.has(role);

  const [rows, setRows] = useState<HaccpRow[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [batches, setBatches] = useState<BatchOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [openCreate, setOpenCreate] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [batchId, setBatchId] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [detail, setDetail] = useState<HaccpRow | null>(null);
  const [editItems, setEditItems] = useState<HaccpRow['items']>([]);
  const [detailPhotos, setDetailPhotos] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const hdr = { ...actingTenantHeaders(), ...actingKitchenHeaders() };
      const [hRes, tRes, bRes] = await Promise.all([
        fetch('/api/haccp-results', { headers: hdr }),
        fetch('/api/haccp-templates?aktif=1', { headers: { ...actingTenantHeaders() } }),
        fetch('/api/production-batches', { headers: hdr }),
      ]);
      const hData = await hRes.json();
      const tData = await tRes.json();
      const bData = await bRes.json();
      if (!hRes.ok) throw new Error(hData?.error || 'Gagal memuat HACCP');
      setRows(Array.isArray(hData) ? hData : []);
      setTemplates(Array.isArray(tData) ? tData : []);
      setBatches(Array.isArray(bData) ? bData : []);
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

  async function createHaccp() {
    if (!templateId || !batchId) {
      toast.error('Pilih template dan batch');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/haccp-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          templateId,
          productionBatchId: batchId,
          evidenceBase64: photos,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal membuat');
      toast.success(`HACCP ${data.noDokumen} dibuat`);
      setOpenCreate(false);
      setTemplateId('');
      setBatchId('');
      setPhotos([]);
      await load();
      setDetail(data as HaccpRow);
      setEditItems(data.items || []);
      setDetailPhotos(data.evidenceUrls || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(row: HaccpRow) {
    const res = await fetch(`/api/haccp-results/${row.id}`, {
      headers: { ...actingTenantHeaders() },
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal detail');
      return;
    }
    setDetail(data as HaccpRow);
    setEditItems(data.items || []);
    setDetailPhotos(data.evidenceUrls || []);
  }

  async function saveItems() {
    if (!detail) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/haccp-results/${detail.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          items: editItems,
          evidenceUrls: detailPhotos,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal simpan');
      toast.success('Checklist disimpan');
      setDetail(data as HaccpRow);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function advance() {
    if (!detail) return;
    const next = HACCP_UI_STATUS_NEXT[detail.status];
    if (!next) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/haccp-results/${detail.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal status');
      toast.success(`Status → ${HACCP_STATUS_LABELS[next]}`);
      setDetail(data as HaccpRow);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <KitchenScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            HACCP Evidence
          </h1>
          <p className="text-sm text-muted-foreground">
            Checklist CCP kritis + foto evidence per batch · export trail di Batch & Expiry
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat
          </Button>
          {canLog && (
            <Button size="sm" onClick={() => setOpenCreate(true)}>
              <Plus className="h-4 w-4 mr-1" /> Catat CCP
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Dokumen</th>
              <th className="text-left p-3">Template</th>
              <th className="text-left p-3">Batch</th>
              <th className="text-left p-3">Status</th>
              <th className="text-right p-3">Foto</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Belum ada evidence HACCP</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-3 font-mono text-xs">{row.noDokumen}</td>
                <td className="p-3">
                  <div>{row.templateNama || row.templateKode}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {HACCP_CATEGORY_LABELS[row.category] || row.category}
                  </div>
                </td>
                <td className="p-3 font-mono text-xs">{row.batchNo || row.productionBatchId}</td>
                <td className="p-3">{HACCP_STATUS_LABELS[row.status] || row.status}</td>
                <td className="p-3 text-right">{row.summary?.photoCount ?? 0}</td>
                <td className="p-3 text-right">
                  <Button variant="ghost" size="sm" onClick={() => void openDetail(row)}>
                    <Eye className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={openCreate} onOpenChange={setOpenCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Catat CCP</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>Template</Label>
              <select
                className="w-full h-10 border rounded-md px-2 text-sm"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
              >
                <option value="">—</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.kode} — {t.nama}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Batch</Label>
              <select
                className="w-full h-10 border rounded-md px-2 text-sm"
                value={batchId}
                onChange={(e) => setBatchId(e.target.value)}
              >
                <option value="">—</option>
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.batchNo} · {b.finishedGoodNama || 'FG'} · {b.kitchenNama || '—'}
                  </option>
                ))}
              </select>
            </div>
            <PhotoUploadField
              label="Evidence foto"
              hint="Disimpan ke media storage (bukan base64 di DB)"
              photos={photos}
              onChange={setPhotos}
              maxPhotos={5}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenCreate(false)}>Batal</Button>
            <Button onClick={() => void createHaccp()} disabled={saving || !templateId || !batchId}>
              {saving ? 'Menyimpan…' : 'Buat'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detail} onOpenChange={(o) => { if (!o) setDetail(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detail?.noDokumen}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 py-2">
              <p className="text-sm text-muted-foreground">
                {detail.templateNama} · batch {detail.batchNo} · {HACCP_STATUS_LABELS[detail.status]}
              </p>
              {editItems.map((item, idx) => (
                <div key={item.key} className="space-y-1 border-b pb-2">
                  <Label>{item.label}</Label>
                  <select
                    className="w-full h-9 border rounded-md px-2 text-sm"
                    value={item.result}
                    disabled={!canLog || !isHaccpEditable(detail.status)}
                    onChange={(e) => {
                      const next = [...editItems];
                      next[idx] = { ...item, result: e.target.value as HaccpItemResult };
                      setEditItems(next);
                    }}
                  >
                    <option value="PASS">PASS</option>
                    <option value="FAIL">FAIL</option>
                    <option value="NA">N/A</option>
                  </select>
                </div>
              ))}
              <PhotoUploadField
                label="Evidence"
                photos={detailPhotos}
                onChange={setDetailPhotos}
                maxPhotos={10}
                disabled={!canLog || !isHaccpEditable(detail.status)}
              />
              <div className="flex flex-wrap gap-2 pt-2">
                {canLog && isHaccpEditable(detail.status) && (
                  <Button size="sm" onClick={() => void saveItems()} disabled={saving}>
                    Simpan checklist
                  </Button>
                )}
                {canManage && HACCP_UI_STATUS_NEXT[detail.status] && (
                  <Button size="sm" variant="secondary" onClick={() => void advance()} disabled={saving}>
                    → {HACCP_STATUS_LABELS[HACCP_UI_STATUS_NEXT[detail.status]!]}
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
