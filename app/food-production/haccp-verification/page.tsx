'use client';

import { useCallback, useEffect, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { Plus, RefreshCw, SquareCheck } from 'lucide-react';
import {
  HACCP_VERIFICATION_RESULT_LABELS,
  HACCP_VERIFICATION_TYPE_LABELS,
  type HaccpVerificationResult,
  type HaccpVerificationType,
} from '@/lib/food-production/haccp-verification';

interface VerRow {
  id: string;
  noDokumen: string;
  verificationType: HaccpVerificationType;
  result: HaccpVerificationResult;
  status: string;
  method: string;
  tanggal: string;
  haccpPlanKode?: string;
  haccpResultNo?: string;
  verifiedByName?: string;
  note?: string;
}

interface PlanOpt {
  id: string;
  kode: string;
  nama: string;
  status: string;
}

interface ResultOpt {
  id: string;
  noDokumen: string;
  templateNama?: string;
  batchNo?: string;
}

export default function HaccpVerificationPage() {
  const [rows, setRows] = useState<VerRow[]>([]);
  const [plans, setPlans] = useState<PlanOpt[]>([]);
  const [results, setResults] = useState<ResultOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [vType, setVType] = useState<HaccpVerificationType>('PLAN');
  const [method, setMethod] = useState('Review dokumen + sampling record');
  const [result, setResult] = useState<HaccpVerificationResult>('PASS');
  const [planId, setPlanId] = useState('');
  const [resultId, setResultId] = useState('');
  const [evidence, setEvidence] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const hdr = actingTenantHeaders();
      const [vRes, pRes, rRes] = await Promise.all([
        fetch('/api/haccp-verifications', { headers: hdr }),
        fetch('/api/haccp-plans', { headers: hdr }),
        fetch('/api/haccp-results', { headers: hdr }),
      ]);
      const vData = await vRes.json();
      const pData = await pRes.json();
      const rData = await rRes.json();
      if (!vRes.ok) throw new Error(vData.error || 'Gagal memuat verifikasi');
      setRows(Array.isArray(vData) ? vData : []);
      setPlans(Array.isArray(pData) ? pData : []);
      setResults(Array.isArray(rData) ? rData : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (complete: boolean) => {
    setBusy(true);
    try {
      const evidenceUrls = evidence
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch('/api/haccp-verifications', {
        method: 'POST',
        headers: { ...actingTenantHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verificationType: vType,
          method,
          result,
          haccpPlanId: vType === 'PLAN' ? planId || undefined : undefined,
          haccpResultId: vType !== 'PLAN' ? resultId || undefined : undefined,
          evidenceUrls,
          note: note || undefined,
          complete,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal menyimpan');
      toast.success(complete ? `Verifikasi ${data.noDokumen} selesai` : `Draft ${data.noDokumen}`);
      setShowCreate(false);
      setNote('');
      setEvidence('');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <SquareCheck className="h-5 w-5" />
            HACCP System Verification
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Record verifikasi periodik plan / kelengkapan monitoring — terpisah dari follow-up KA.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-1 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Muat ulang
          </Button>
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            <Plus className="mr-1 h-4 w-4" />
            Catat verifikasi
          </Button>
        </div>
      </div>

      {showCreate && (
        <div className="rounded-lg border p-4 space-y-3 max-w-2xl">
          <h2 className="text-sm font-semibold">Verifikasi baru</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs space-y-1">
              <span className="text-muted-foreground">Tipe</span>
              <select
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={vType}
                onChange={(e) => setVType(e.target.value as HaccpVerificationType)}
              >
                {(Object.keys(HACCP_VERIFICATION_TYPE_LABELS) as HaccpVerificationType[]).map((k) => (
                  <option key={k} value={k}>{HACCP_VERIFICATION_TYPE_LABELS[k]}</option>
                ))}
              </select>
            </label>
            <label className="text-xs space-y-1">
              <span className="text-muted-foreground">Hasil</span>
              <select
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={result}
                onChange={(e) => setResult(e.target.value as HaccpVerificationResult)}
              >
                {(Object.keys(HACCP_VERIFICATION_RESULT_LABELS) as HaccpVerificationResult[]).map((k) => (
                  <option key={k} value={k}>{HACCP_VERIFICATION_RESULT_LABELS[k]}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-xs space-y-1">
            <span className="text-muted-foreground">Metode</span>
            <input
              className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            />
          </label>
          {vType === 'PLAN' ? (
            <label className="block text-xs space-y-1">
              <span className="text-muted-foreground">HACCP Plan</span>
              <select
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
              >
                <option value="">— pilih —</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>{p.kode} · {p.nama} ({p.status})</option>
                ))}
              </select>
            </label>
          ) : (
            <label className="block text-xs space-y-1">
              <span className="text-muted-foreground">HACCP Result</span>
              <select
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={resultId}
                onChange={(e) => setResultId(e.target.value)}
              >
                <option value="">— pilih —</option>
                {results.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.noDokumen} · {r.templateNama || ''} · {r.batchNo || ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-xs space-y-1">
            <span className="text-muted-foreground">Evidence URL (wajib untuk PASS · COMPLETED)</span>
            <textarea
              className="w-full rounded border bg-background px-2 py-1.5 text-sm min-h-[60px]"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="https://… atau path media, satu per baris"
            />
          </label>
          <label className="block text-xs space-y-1">
            <span className="text-muted-foreground">Catatan</span>
            <input
              className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void create(false)}>
              Simpan draft
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void create(true)}>
              Selesai (COMPLETED)
            </Button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="p-2 font-medium">No</th>
              <th className="p-2 font-medium">Tipe</th>
              <th className="p-2 font-medium">Hasil</th>
              <th className="p-2 font-medium">Target</th>
              <th className="p-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-2 font-mono text-xs">{row.noDokumen}</td>
                <td className="p-2">
                  <div>{HACCP_VERIFICATION_TYPE_LABELS[row.verificationType]}</div>
                  <div className="text-xs text-muted-foreground">{row.method}</div>
                </td>
                <td className="p-2">{HACCP_VERIFICATION_RESULT_LABELS[row.result]}</td>
                <td className="p-2 text-xs text-muted-foreground">
                  {row.haccpPlanKode || row.haccpResultNo || '—'}
                  {row.verifiedByName ? ` · ${row.verifiedByName}` : ''}
                </td>
                <td className="p-2 text-xs">{row.status}</td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-muted-foreground">
                  Belum ada record verifikasi sistem
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
