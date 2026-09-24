'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { useApiMutation } from '@/lib/hooks/use-api-mutation';
import { queryKeys } from '@/lib/query-keys';
import { formatDateTime, formatNumber } from '@/lib/format';
import { asArray, asObject, num, str, type JsonObject } from '@/types/json';

const LINKABLE_PLAN_STATUSES = new Set(['APPROVED', 'PROCESSING', 'COMPLETED']);

function isoDaysAgo(days: number): string {
  return new Date(Date.now() + 7 * 3600_000 - days * 86_400_000).toISOString().slice(0, 10);
}

type RowDraft = { planId: string; reason: string };

export function UnlinkedReleasesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [from, setFrom] = useState(() => isoDaysAgo(30));
  const [to, setTo] = useState(() => isoDaysAgo(0));
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [busyId, setBusyId] = useState('');

  const qs = new URLSearchParams({ from, to }).toString();
  const { data, isFetching, error } = useApiQuery<JsonObject>(
    [...queryKeys.inventoryReleases.all, 'unlinked', from, to],
    `/api/inventory-releases/unlinked?${qs}`,
    { enabled: open },
  );
  const { data: plansData = [] } = useApiQuery<JsonObject[]>(
    ['food-production', 'production-plans', 'release-link-all'],
    '/api/production-plans',
    { enabled: open },
  );
  const otherPlans = useMemo(
    () => (Array.isArray(plansData) ? plansData : [])
      .filter((p) => LINKABLE_PLAN_STATUSES.has(str(p.status)))
      .sort((a, b) => str(b.tanggal).localeCompare(str(a.tanggal))),
    [plansData],
  );
  const rows = asArray(asObject(data).rows).map(asObject);

  const mutation = useApiMutation<JsonObject, JsonObject>([queryKeys.inventoryReleases.all]);

  const draftOf = (row: JsonObject): RowDraft => drafts[str(row.id)] || {
    planId: str(asObject(asArray(row.candidates)[0]).productionPlanId),
    reason: '',
  };
  const setDraft = (id: string, patch: Partial<RowDraft>, row: JsonObject) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...draftOf(row), ...prev[id], ...patch } }));
  };

  const submit = async (row: JsonObject, kind: 'link-plan' | 'dismiss-link') => {
    const id = str(row.id);
    const d = draftOf(row);
    if (d.reason.trim().length < 5) {
      toast.error('Alasan wajib diisi (minimal 5 karakter)');
      return;
    }
    if (kind === 'link-plan' && !d.planId) {
      toast.error('Pilih Rencana Produksi');
      return;
    }
    setBusyId(id);
    try {
      await mutation.mutateAsync({
        url: `/api/inventory-releases/${id}/${kind}`,
        body: kind === 'link-plan' ? { productionPlanId: d.planId, reason: d.reason } : { reason: d.reason },
      });
      toast.success(kind === 'link-plan'
        ? `${str(row.noRelease)} ditautkan ke rencana`
        : `${str(row.noRelease)} ditandai bukan produksi`);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>RL belum tertaut rencana</DialogTitle>
          <p className="text-sm text-slate-500">
            Release yang sudah diposting tanpa Rencana Produksi, padahal keperluannya produksi atau barangnya
            cocok resep rencana hari itu / besoknya. Tidak dihitung ke rencana mana pun sampai ditautkan.
          </p>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label>Dari</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1">
            <Label>Sampai</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9" />
          </div>
          <p className="text-xs text-slate-500 pb-2">
            {isFetching ? 'Memuat…' : `${rows.length} release`}
          </p>
        </div>
        <div className="overflow-y-auto flex-1 space-y-3">
          {error && <p className="text-sm text-red-700">{error.message}</p>}
          {!isFetching && !error && !rows.length && (
            <p className="text-sm text-slate-400 text-center py-8">Tidak ada RL belum tertaut di rentang ini</p>
          )}
          {rows.map((row) => {
            const id = str(row.id);
            const d = draftOf(row);
            const candidates = asArray(row.candidates).map(asObject);
            const candidateIds = new Set(candidates.map((c) => str(c.productionPlanId)));
            return (
              <div key={id} className="border rounded-md p-3 text-sm space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <span className="font-mono text-xs">{str(row.noRelease)}</span>
                    <span className="text-xs text-slate-500"> · {formatDateTime(str(row.tanggal))}</span>
                    <span className="text-xs text-slate-500"> · {str(row.lokasiNama) || str(row.lokasiKode)}</span>
                  </div>
                  <div className="text-xs text-slate-500">
                    Dibuat {str(asObject(row.createdBy).userName) || '—'}
                    {' '}· disetujui {str(asObject(row.approvedBy).userName) || '—'}
                  </div>
                </div>
                <div className="text-xs">
                  Keperluan: <span className="font-medium">{str(row.keperluan) || '—'}</span>
                  {row.looksProduction === true && (
                    <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">keperluan produksi</span>
                  )}
                </div>
                <div className="text-xs text-slate-600">
                  {asArray(row.items).map(asObject).map((it) => (
                    `${str(it.nama) || str(it.kode)} ${formatNumber(num(it.qty))} ${str(it.satuan)}`
                  )).join(' · ')}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2 items-center">
                  <select
                    className="h-9 border rounded-md px-2 text-sm bg-white"
                    value={d.planId}
                    onChange={(e) => setDraft(id, { planId: e.target.value }, row)}
                  >
                    <option value="">— Pilih rencana —</option>
                    {candidates.length > 0 && (
                      <optgroup label="Cocok resep">
                        {candidates.map((c) => (
                          <option key={str(c.productionPlanId)} value={str(c.productionPlanId)}>
                            {str(c.productionPlanNo)} · {str(c.tanggal)} · {str(c.planStatus)}
                            {' '}· {num(c.overlapProductCount)} bahan cocok
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="Rencana lain">
                      {otherPlans.filter((p) => !candidateIds.has(str(p.id))).map((p) => (
                        <option key={str(p.id)} value={str(p.id)}>
                          {str(p.noDokumen)} · {str(p.tanggal)} · {str(p.status)}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <Input
                    className="h-9"
                    maxLength={300}
                    placeholder="Alasan (wajib, dicatat di audit)"
                    value={d.reason}
                    onChange={(e) => setDraft(id, { reason: e.target.value }, row)}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={busyId === id}
                      onClick={() => { void submit(row, 'link-plan'); }}
                    >
                      Tautkan
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === id}
                      onClick={() => { void submit(row, 'dismiss-link'); }}
                      title="Bukan untuk produksi — keluarkan dari worklist"
                    >
                      Bukan produksi
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Tutup</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
