'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { ClipboardCheck, RefreshCw, Search } from 'lucide-react';
import FoodSafetyBreadcrumb from '@/components/food-safety/FoodSafetyBreadcrumb';
import {
  AUDIT_READINESS_STATUS_LABELS,
  type AuditReadinessSnapshot,
} from '@/lib/food-production/food-safety-audit-readiness';
import type { TraceabilityResult } from '@/lib/food-production/food-safety-traceability';

function statusClass(s: string): string {
  if (s === 'READY') return 'text-emerald-700';
  if (s === 'PARTIAL') return 'text-amber-700';
  return 'text-red-700';
}

export default function FoodSafetyAuditPage() {
  const [snap, setSnap] = useState<AuditReadinessSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [batchId, setBatchId] = useState('');
  const [lotId, setLotId] = useState('');
  const [trace, setTrace] = useState<TraceabilityResult | null>(null);
  const [traceBusy, setTraceBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/food-safety-readiness', {
        headers: actingTenantHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat readiness');
      setSnap(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runTrace = async (mode: 'batch' | 'lot') => {
    setTraceBusy(true);
    setTrace(null);
    try {
      const q = mode === 'batch'
        ? `productionBatchId=${encodeURIComponent(batchId.trim())}`
        : `ingredientLotId=${encodeURIComponent(lotId.trim())}`;
      const res = await fetch(`/api/food-safety-traceability?${q}`, {
        headers: actingTenantHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal trace');
      setTrace(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setTraceBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <FoodSafetyBreadcrumb
            items={[
              { href: '/kitchen-assurance/audit', label: 'Siap audit' },
              { label: 'Panel kesiapan' },
            ]}
          />
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold tracking-tight">
            <ClipboardCheck className="h-5 w-5" />
            Panel kesiapan audit
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Agregasi bukti prasyarat + HACCP + telusur lot (bukan sertifikasi resmi).
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`mr-1 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Muat ulang
        </Button>
      </div>

      {snap && (
        <div className="space-y-4">
          <div className="rounded-lg border p-4">
            <p className={`text-lg font-semibold ${statusClass(snap.status)}`}>
              {AUDIT_READINESS_STATUS_LABELS[snap.status]}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Lookback {snap.lookbackDays} hari · {snap.asOf}
            </p>
            <p className="text-xs text-muted-foreground mt-2">{snap.disclaimer}</p>
          </div>

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {snap.pillars.map((p) => {
              const inner = (
                <>
                  <div className={`text-sm font-semibold ${statusClass(p.status)}`}>
                    {AUDIT_READINESS_STATUS_LABELS[p.status]}
                  </div>
                  <div className="font-medium text-sm mt-1">{p.label}</div>
                  <p className="text-xs text-muted-foreground mt-1">{p.detail}</p>
                </>
              );
              if (p.href && p.status !== 'READY') {
                return (
                  <Link key={p.key} href={p.href} className="rounded-lg border p-3 hover:border-slate-400">
                    {inner}
                  </Link>
                );
              }
              return (
                <div key={p.key} className="rounded-lg border p-3">
                  {inner}
                </div>
              );
            })}
          </div>

          <div className="overflow-hidden rounded-lg border">
            <div className="bg-muted/50 px-3 py-2 text-sm font-medium">
              Mapping requirement BGN ({snap.bgnRequirements.filter((r) => r.hasEvidence).length}/
              {snap.bgnRequirements.length} ber-evidence)
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">Kode</th>
                  <th className="p-2">Requirement</th>
                  <th className="p-2">Dasar</th>
                  <th className="p-2">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {snap.bgnRequirements.map((r) => (
                  <tr key={r.requirementId} className="border-t">
                    <td className="p-2 font-mono text-xs">{r.kode}</td>
                    <td className="p-2">
                      {r.href ? (
                        <Link href={r.href} className="text-blue-700 hover:underline">
                          {r.nama}
                        </Link>
                      ) : (
                        r.nama
                      )}
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">{r.bgnCode || r.sourceRef || '—'}</td>
                    <td className={`p-2 text-xs ${r.hasEvidence ? 'text-emerald-700' : 'text-red-700'}`}>
                      {r.hasEvidence ? 'Ada' : (
                        r.href ? (
                          <Link href={r.href} className="text-red-700 underline">Belum — buka Setup</Link>
                        ) : 'Belum'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="rounded-lg border p-4 space-y-3">
        <h2 className="font-semibold text-sm flex items-center gap-2">
          <Search className="h-4 w-4" />
          Traceability (candidate-lot)
        </h2>
        <p className="text-xs text-muted-foreground">
          Backward: batch → lot/supplier. Forward: lot → batch/distribusi. Bukan observasi fisik.
        </p>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs space-y-1">
            <span className="text-muted-foreground">productionBatchId</span>
            <input
              className="block w-56 rounded border bg-background px-2 py-1.5 text-sm font-mono"
              value={batchId}
              onChange={(e) => setBatchId(e.target.value)}
            />
          </label>
          <Button size="sm" disabled={traceBusy || !batchId.trim()} onClick={() => void runTrace('batch')}>
            Backward
          </Button>
          <label className="text-xs space-y-1">
            <span className="text-muted-foreground">ingredientLotId</span>
            <input
              className="block w-56 rounded border bg-background px-2 py-1.5 text-sm font-mono"
              value={lotId}
              onChange={(e) => setLotId(e.target.value)}
            />
          </label>
          <Button size="sm" variant="secondary" disabled={traceBusy || !lotId.trim()} onClick={() => void runTrace('lot')}>
            Forward
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/food-production/batch">Batch & trail</Link>
          </Button>
        </div>

        {trace && (
          <div className="space-y-2 text-sm border-t pt-3">
            <p className="text-xs text-muted-foreground">{trace.disclaimer}</p>
            <p className="font-medium">
              {trace.direction} · {trace.attribution}
            </p>
            {trace.candidateLots.length > 0 && (
              <div>
                <div className="text-xs font-semibold uppercase text-muted-foreground">Candidate lots</div>
                <ul className="mt-1 space-y-1">
                  {trace.candidateLots.map((l) => (
                    <li key={l.lotId} className="font-mono text-xs">
                      {l.lotNo || l.lotId}
                      {l.supplierId ? ` · supplier ${l.supplierId}` : ''}
                      {l.noGRN ? ` · ${l.noGRN}` : ''}
                      {` · qty ${l.allocatedQty}`}
                      {l.weightShare != null ? ` · share ${(l.weightShare * 100).toFixed(0)}%` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {trace.candidateBatches.length > 0 && (
              <div>
                <div className="text-xs font-semibold uppercase text-muted-foreground">Candidate batches</div>
                <ul className="mt-1 space-y-1">
                  {trace.candidateBatches.map((b) => (
                    <li key={b.batchId} className="text-xs">
                      <span className="font-mono">{b.batchNo || b.batchId}</span>
                      {b.finishedGoodNama ? ` · ${b.finishedGoodNama}` : ''}
                      {b.foodSafetyStatus ? ` · ${b.foodSafetyStatus}` : ''}
                      {b.distributionIds?.length
                        ? ` · dist ${b.distributionIds.length}`
                        : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
