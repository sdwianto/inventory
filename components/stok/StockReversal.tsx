'use client';

/** Fase 5c — pembalik stok (RVS) untuk RL, PBL, penyesuaian, dan transfer: ajukan dari detail dokumen, setujui dari daftar menunggu. */

import type { JsonObject } from '@/types/json';
import { str, num, asArray } from '@/types/json';
import { useCallback, useState } from 'react';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { toast } from 'sonner';
import { Undo2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { fetchJson } from '@/lib/fetch-json';
import { formatDateTime, formatNumber } from '@/lib/format';
import { getUser } from '@/lib/auth-client';
import { useActingTenantId } from '@/lib/hooks/use-acting-tenant-id';
import { withActingTenantQuery } from '@/lib/tenant-api';

export type StockReversalSourceType = 'RELEASE' | 'FP_ISSUE' | 'PENYESUAIAN' | 'TRANSFER';

const REQUEST_ROLES = new Set(['GUDANG', 'SUPERVISOR', 'ADMIN', 'OWNER', 'MASTER']);

export const STOCK_REVERSAL_SOURCE_LABEL: Record<StockReversalSourceType, string> = {
  RELEASE: 'RL',
  FP_ISSUE: 'PBL',
  PENYESUAIAN: 'Penyesuaian',
  TRANSFER: 'Transfer',
};

const SOURCE_EFFECT: Record<StockReversalSourceType, string> = {
  RELEASE: 'Seluruh bahan RL dikembalikan ke gudang dan lot asalnya; jurnal pemakaian dibalik.',
  FP_ISSUE: 'Seluruh bahan PBL dikembalikan ke gudang dan lot asalnya; jurnal pemakaian dibalik; PBL menjadi CANCELLED.',
  PENYESUAIAN: 'Selisih penyesuaian dibatalkan dengan mutasi lawan; jurnal penyesuaian dibalik.',
  TRANSFER: 'Stok dan lot dipindah kembali dari gudang tujuan ke gudang asal.',
};

function useScoped() {
  const actingTenantId = useActingTenantId();
  const isMaster = getUser()?.role === 'MASTER';
  const scopeReady = !isMaster || Boolean(actingTenantId);
  const scoped = useCallback(
    (path: string) => withActingTenantQuery(path, actingTenantId, isMaster),
    [actingTenantId, isMaster],
  );
  return { scoped, scopeReady };
}

function canRequest() {
  return REQUEST_ROLES.has(String(getUser()?.role || ''));
}

function asObjectSafe(v: unknown): JsonObject {
  return v && typeof v === 'object' ? v as JsonObject : {};
}

function LinesTable({ lines }: { lines: JsonObject[] }) {
  if (!lines.length) return null;
  return (
    <table className="w-full text-xs border rounded">
      <thead className="bg-slate-100 text-slate-600">
        <tr>
          <th className="px-2 py-1 text-left">Produk</th>
          <th className="px-2 py-1 text-left">Gudang</th>
          <th className="px-2 py-1 text-right">Mutasi lawan</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => {
          const q = num(l.deltaQtyBase);
          return (
            <tr key={`${str(l.lineRef)}-${str(l.productId)}`} className="border-t">
              <td className="px-2 py-1">{str(l.productNama) || str(l.productKode) || str(l.productId)}</td>
              <td className="px-2 py-1">{str(l.warehouseKode)}</td>
              <td className={`px-2 py-1 text-right tabular-nums ${q > 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                {q > 0 ? '+' : ''}{formatNumber(q)} {str(l.satuan)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PendingActions({ rev, onDone }: { rev: JsonObject; onDone: () => void }) {
  const { scoped } = useScoped();
  const [busy, setBusy] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const id = encodeURIComponent(str(rev.id));

  const run = async (action: 'approve' | 'reject' | 'cancel', body: Record<string, unknown> = {}) => {
    setBusy(action);
    try {
      await fetchJson<JsonObject>(scoped(`/api/stock-reversals/${id}/${action}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      toast.success(
        action === 'approve'
          ? `${str(rev.noReversal)} disetujui — ${str(rev.sourceNo)} dibalik`
          : action === 'reject' ? `${str(rev.noReversal)} ditolak` : `${str(rev.noReversal)} dibatalkan`,
      );
      setRejectOpen(false);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setBusy('');
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {rev.canApprove === true && (
        <>
          <Button size="sm" className="h-7 text-xs bg-red-600 hover:bg-red-700" disabled={!!busy} onClick={() => run('approve')}>
            {busy === 'approve' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Setujui pembalik'}
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!!busy} onClick={() => { setRejectReason(''); setRejectOpen(true); }}>
            Tolak
          </Button>
        </>
      )}
      {rev.canCancel === true && (
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!!busy} onClick={() => run('cancel')}>
          {busy === 'cancel' ? 'Membatalkan…' : 'Batalkan'}
        </Button>
      )}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Tolak pembalik {str(rev.noReversal)}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="stock-rvs-reject-reason">Alasan penolakan</Label>
            <Textarea id="stock-rvs-reject-reason" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} maxLength={500} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>Batal</Button>
            <Button disabled={rejectReason.trim().length < 3 || !!busy} onClick={() => run('reject', { reason: rejectReason.trim() })}>
              {busy === 'reject' ? 'Menolak…' : 'Tolak pengajuan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Bagian pembalik di detail dokumen: status pembalik atau tombol ajukan. */
export function StockReversalSection({
  sourceType,
  doc,
  eligible,
  onChanged,
}: {
  sourceType: StockReversalSourceType;
  doc: JsonObject | null;
  /** Dokumen dalam status yang bisa dibalik (mis. RL POSTED). */
  eligible: boolean;
  onChanged: () => void;
}) {
  const { scoped, scopeReady } = useScoped();
  const sourceId = str(doc?.id);
  const pendingUrl = sourceId && scopeReady && doc?.reversalPendingId
    ? scoped(`/api/stock-reversals?sourceType=${sourceType}&sourceId=${encodeURIComponent(sourceId)}&status=PENDING_APPROVAL`)
    : null;
  const { data: pendingRows, refetch } = useApiQuery<JsonObject[]>(
    ['stock-reversals', 'pending-for-doc', pendingUrl || ''],
    pendingUrl,
    { staleTime: 0 },
  );
  const pending = pendingRows?.[0] || null;
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<JsonObject | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const label = STOCK_REVERSAL_SOURCE_LABEL[sourceType];

  const openRequest = async () => {
    setOpen(true);
    setReason('');
    setCheck(null);
    setChecking(true);
    try {
      setCheck(await fetchJson<JsonObject>(scoped(`/api/stock-reversals/check?sourceType=${sourceType}&sourceId=${encodeURIComponent(sourceId)}`)));
    } catch (e) {
      setCheck({ reversible: false, reason: e instanceof Error ? e.message : String(e) });
    }
    setChecking(false);
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const created = await fetchJson<JsonObject>(scoped('/api/stock-reversals'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceType, sourceId, reason: reason.trim() }),
      });
      toast.success(`${str(created.noReversal)} diajukan — menunggu persetujuan penyetuju lain`);
      setOpen(false);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setSubmitting(false);
  };

  if (!doc) return null;

  if (doc.reversedBy) {
    const by = asObjectSafe(doc.reversedBy);
    return (
      <div className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700">
        {label} ini sudah dibalik lewat <strong className="font-mono">{str(by.noReversal)}</strong>
        {str(doc.reversedAt) ? ` pada ${formatDateTime(str(doc.reversedAt))}` : ''}. Kartu stok memuat mutasi lawannya.
      </div>
    );
  }

  if (doc.reversalPendingId) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-2">
        <div>
          Pengajuan pembalik <strong className="font-mono">{str(doc.reversalPendingNo)}</strong> menunggu persetujuan
          {pending ? ` — diajukan ${str(asObjectSafe(pending.requestedBy).userName)}: "${str(pending.reason)}"` : ''}.
        </div>
        {pending && <PendingActions rev={pending} onDone={() => { void refetch(); onChanged(); }} />}
      </div>
    );
  }

  if (!eligible || !canRequest()) return null;

  const lines = asArray(check?.lines) as JsonObject[];
  return (
    <>
      <Button variant="outline" size="sm" className="text-red-700 border-red-300 hover:bg-red-50" onClick={openRequest}>
        <Undo2 className="w-4 h-4 mr-1" />
        Ajukan pembalik
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Ajukan pembalik {label} {str(doc.noRelease || doc.noDokumen || doc.noPenyesuaian || doc.noTransfer)}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-xs text-slate-600">
              {SOURCE_EFFECT[sourceType]} Mutasi lawan diposting hari ini dengan harga kartu asli.
              Perlu persetujuan SUPERVISOR/ADMIN selain pengaju (pengaju tidak bisa menyetujui sendiri, termasuk ADMIN).
            </p>
            {checking && <p className="text-xs text-slate-500 flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Memeriksa kelayakan…</p>}
            {check && check.reversible !== true && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{str(check.reason)}</div>
            )}
            {check?.reversible === true && (
              <>
                <LinesTable lines={lines} />
                <div className="space-y-1.5">
                  <Label htmlFor="stock-rvs-reason">Alasan pembalik</Label>
                  <Textarea id="stock-rvs-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} placeholder="mis. salah gudang, salah item, dokumen dobel" />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Tutup</Button>
            <Button
              className="bg-red-600 hover:bg-red-700"
              disabled={check?.reversible !== true || reason.trim().length < 3 || submitting}
              onClick={submit}
            >
              {submitting ? 'Mengajukan…' : 'Ajukan pembalik'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Daftar pengajuan pembalik stok yang menunggu persetujuan (opsional difilter per jenis sumber). */
export function PendingStockReversals({
  sourceType,
  refreshKey,
  onChanged,
}: {
  sourceType?: StockReversalSourceType;
  refreshKey?: unknown;
  onChanged: () => void;
}) {
  const { scoped, scopeReady } = useScoped();
  const qs = `status=PENDING_APPROVAL${sourceType ? `&sourceType=${sourceType}` : ''}`;
  const url = scopeReady && canRequest() ? scoped(`/api/stock-reversals?${qs}`) : null;
  const { data, refetch } = useApiQuery<JsonObject[]>(
    ['stock-reversals', 'pending', url || '', String(refreshKey ?? '')],
    url,
    { staleTime: 15_000 },
  );
  const rows = data || [];
  if (!rows.length) return null;
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900 space-y-2">
      <div className="font-medium flex items-center gap-1.5">
        <Undo2 className="w-4 h-4" /> {rows.length} pengajuan pembalik stok menunggu persetujuan
      </div>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={str(r.id)} className="bg-white/70 border border-amber-200 rounded px-3 py-2 space-y-1.5">
            <div className="text-xs">
              <span className="font-mono font-medium">{str(r.noReversal)}</span>
              {' · '}{STOCK_REVERSAL_SOURCE_LABEL[str(r.sourceType) as StockReversalSourceType] || str(r.sourceType)}
              {' '}<span className="font-mono">{str(r.sourceNo)}</span>
              {' · diajukan '}{str(asObjectSafe(r.requestedBy).userName) || '—'}
              {str(r.requestedAt) ? ` (${formatDateTime(str(r.requestedAt))})` : ''}
              {' — '}<span className="italic">{str(r.reason)}</span>
            </div>
            <LinesTable lines={asArray(r.lines) as JsonObject[]} />
            <PendingActions rev={r} onDone={() => { void refetch(); onChanged(); }} />
          </div>
        ))}
      </div>
    </div>
  );
}
