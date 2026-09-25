'use client';

/** Fase 3.6 — pembalik GRN (RVS): ajukan dari detail GRN POSTED, setujui/tolak/batal dari daftar menunggu. */

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

const REQUEST_ROLES = new Set(['GUDANG', 'SUPERVISOR', 'ADMIN', 'OWNER', 'MASTER']);

export const GRN_REVERSAL_STATUS_LABEL: Record<string, string> = {
  PENDING_APPROVAL: 'Menunggu persetujuan',
  POSTED: 'Terposting',
  REJECTED: 'Ditolak',
  CANCELLED: 'Dibatalkan',
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

export function canRequestGrnReversal() {
  return REQUEST_ROLES.has(String(getUser()?.role || ''));
}

function LinesTable({ lines }: { lines: JsonObject[] }) {
  if (!lines.length) return null;
  return (
    <table className="w-full text-xs border rounded">
      <thead className="bg-slate-100 text-slate-600">
        <tr>
          <th className="px-2 py-1 text-left">Produk</th>
          <th className="px-2 py-1 text-left">Lot</th>
          <th className="px-2 py-1 text-left">Gudang</th>
          <th className="px-2 py-1 text-right">Qty keluar</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={`${str(l.productId)}-${str(l.warehouseKode)}-${str(l.lotNo)}`} className="border-t">
            <td className="px-2 py-1">{str(l.productNama) || str(l.productKode) || str(l.productId)}</td>
            <td className="px-2 py-1 font-mono">{str(l.lotNo)}</td>
            <td className="px-2 py-1">{str(l.warehouseKode)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{formatNumber(num(l.qty))} {str(l.satuan)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Aksi pengajuan menunggu: setujui / tolak (penyetuju) atau batal (pengaju). */
function PendingActions({ rev, onDone }: { rev: JsonObject; onDone: () => void }) {
  const { scoped } = useScoped();
  const [busy, setBusy] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const id = encodeURIComponent(str(rev.id));

  const run = async (action: 'approve' | 'reject' | 'cancel', body: Record<string, unknown> = {}) => {
    setBusy(action);
    try {
      await fetchJson<JsonObject>(scoped(`/api/grn-reversals/${id}/${action}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      toast.success(
        action === 'approve'
          ? `${str(rev.noReversal)} disetujui — GRN ${str(rev.noGRN)} dibalik`
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
            <Label htmlFor="rvs-reject-reason">Alasan penolakan</Label>
            <Textarea id="rvs-reject-reason" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} maxLength={500} />
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

function asObjectSafe(v: unknown): JsonObject {
  return v && typeof v === 'object' ? v as JsonObject : {};
}

/** Bagian pembalik di detail GRN: status pembalik + tombol ajukan. */
export function GrnReversalSection({ grn, onChanged }: { grn: JsonObject | null; onChanged: () => void }) {
  const { scoped, scopeReady } = useScoped();
  const grnId = str(grn?.id);
  const status = str(grn?.status);
  const pendingUrl = grnId && scopeReady && grn?.reversalPendingId
    ? scoped(`/api/grn-reversals?grnId=${encodeURIComponent(grnId)}&status=PENDING_APPROVAL`)
    : null;
  const { data: pendingRows } = useApiQuery<JsonObject[]>(
    ['grn-reversals', 'pending-for-grn', pendingUrl || ''],
    pendingUrl,
    { staleTime: 0 },
  );
  const pending = pendingRows?.[0] || null;
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<JsonObject | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const openRequest = async () => {
    setOpen(true);
    setReason('');
    setCheck(null);
    setChecking(true);
    try {
      setCheck(await fetchJson<JsonObject>(scoped(`/api/grn-reversals/check?grnId=${encodeURIComponent(grnId)}`)));
    } catch (e) {
      setCheck({ reversible: false, reason: e instanceof Error ? e.message : String(e) });
    }
    setChecking(false);
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const created = await fetchJson<JsonObject>(scoped('/api/grn-reversals'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grnId, reason: reason.trim() }),
      });
      toast.success(`${str(created.noReversal)} diajukan — menunggu persetujuan SUPERVISOR/ADMIN`);
      setOpen(false);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setSubmitting(false);
  };

  if (!grn) return null;

  if (status === 'REVERSED') {
    const by = asObjectSafe(grn.reversedBy);
    return (
      <div className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700">
        GRN ini sudah dibalik lewat <strong className="font-mono">{str(by.noReversal)}</strong>
        {str(grn.reversedAt) ? ` pada ${formatDateTime(str(grn.reversedAt))}` : ''}. Stok, qty PO, dan akrual GRNI sudah dikembalikan.
      </div>
    );
  }
  if (status !== 'POSTED') return null;

  if (grn.reversalPendingId) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-2">
        <div>
          Pengajuan pembalik <strong className="font-mono">{str(grn.reversalPendingNo)}</strong> menunggu persetujuan
          {pending ? ` — diajukan ${str(asObjectSafe(pending.requestedBy).userName)}: "${str(pending.reason)}"` : ''}.
        </div>
        {pending && <PendingActions rev={pending} onDone={onChanged} />}
      </div>
    );
  }

  if (!canRequestGrnReversal()) return null;

  const lines = asArray(check?.lines) as JsonObject[];
  return (
    <>
      <Button variant="outline" className="text-red-700 border-red-300 hover:bg-red-50" onClick={openRequest}>
        <Undo2 className="w-4 h-4 mr-1" />
        Ajukan pembalik
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Ajukan pembalik GRN {str(grn.noGRN)}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-xs text-slate-600">
              Pembalik mengeluarkan seluruh qty GRN dari lot aslinya, mengurangi qty diterima di PO, dan membalik akrual GRNI.
              Perlu persetujuan SUPERVISOR/ADMIN selain pengaju.
            </p>
            {checking && <p className="text-xs text-slate-500 flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Memeriksa kelayakan…</p>}
            {check && check.reversible !== true && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{str(check.reason)}</div>
            )}
            {check?.reversible === true && (
              <>
                <LinesTable lines={lines} />
                <div className="space-y-1.5">
                  <Label htmlFor="rvs-reason">Alasan pembalik</Label>
                  <Textarea id="rvs-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} placeholder="mis. DO salah diterima, barang milik dapur lain" />
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

/** Daftar pengajuan pembalik yang menunggu persetujuan (di atas tabel GRN). */
export function PendingGrnReversals({ refreshKey, onChanged }: { refreshKey?: unknown; onChanged: () => void }) {
  const { scoped, scopeReady } = useScoped();
  const url = scopeReady && canRequestGrnReversal() ? scoped('/api/grn-reversals?status=PENDING_APPROVAL') : null;
  const { data, refetch } = useApiQuery<JsonObject[]>(
    ['grn-reversals', 'pending', url || '', String(refreshKey ?? '')],
    url,
    { staleTime: 15_000 },
  );
  const rows = data || [];
  const load = () => { void refetch(); };

  if (!rows.length) return null;
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900 space-y-2">
      <div className="font-medium flex items-center gap-1.5">
        <Undo2 className="w-4 h-4" /> {rows.length} pengajuan pembalik GRN menunggu persetujuan
      </div>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={str(r.id)} className="bg-white/70 border border-amber-200 rounded px-3 py-2 space-y-1.5">
            <div className="text-xs">
              <span className="font-mono font-medium">{str(r.noReversal)}</span>
              {' · GRN '}<span className="font-mono">{str(r.noGRN)}</span>
              {str(r.noPO) ? <> · PO <span className="font-mono">{str(r.noPO)}</span></> : null}
              {' · diajukan '}{str(asObjectSafe(r.requestedBy).userName) || '—'}
              {str(r.requestedAt) ? ` (${formatDateTime(str(r.requestedAt))})` : ''}
              {' — '}<span className="italic">{str(r.reason)}</span>
            </div>
            <LinesTable lines={asArray(r.lines) as JsonObject[]} />
            <PendingActions rev={r} onDone={() => { load(); onChanged(); }} />
          </div>
        ))}
      </div>
    </div>
  );
}
