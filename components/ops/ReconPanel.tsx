'use client';

import { Fragment, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Play } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { useApiMutation } from '@/lib/hooks/use-api-mutation';
import { queryKeys } from '@/lib/query-keys';
import { formatDateTime, formatNumber } from '@/lib/format';
import { setActingTenantId } from '@/lib/acting-tenant-client';
import { RECON_JOBS, type ReconFinding, type ReconJob, type ReconKind, type ReconReport } from '@/lib/recon/types';

type ReportRow = Omit<ReconReport, 'findings'> & { findingCount: number };
type ReconOverview = {
  jobs: ReconJob[];
  kinds: Record<ReconJob, ReconKind[]>;
  reports: ReportRow[];
  totals: Partial<Record<ReconKind, number>>;
};

const JOB_LABEL: Record<ReconJob, string> = {
  stock: 'Stok',
  'po-receipt': 'Terima PO',
  grni: 'GRNI',
  'plan-issue': 'Rencana vs RL',
  controls: 'Master & kontrol',
};

const KIND_LABEL: Record<ReconKind, string> = {
  STOCK_HOME_VS_LEDGER: 'Gudang ≠ kartu',
  STOCK_MASTER_VS_LOKASI: 'Master ≠ gudang',
  STOCK_PHANTOM_WAREHOUSE: 'Stok di gudang lain',
  STOCK_LEDGER_NEGATIVE: 'Kartu negatif',
  STOCK_LOT_GT_LOKASI: 'Lot > gudang',
  STOCK_BIN_GT_LOKASI: 'Bin > gudang',
  STOCK_FLOAT_DUST: 'Float dust',
  STOCK_ZERO_COST_OUT: 'Keluar tanpa harga',
  STOCK_LEDGER_ROW_WITHOUT_REF: 'Kartu tanpa dokumen',
  PO_QTY_RECEIVED_MISMATCH: 'Qty diterima PO ≠ GRN',
  PO_GRN_NOT_APPLIED: 'GRN belum ke PO',
  PO_GRN_REVERSAL_NOT_APPLIED: 'Pembalik GRN belum ke PO',
  GRNI_BILL_RESIDUAL: 'Sisa GRNI per tagihan',
  GRNI_UNBILLED_AGED: 'GRN lama belum ditagih',
  GL_INVENTORY_VS_VALUATION: 'GL Persediaan ≠ nilai stok',
  GL_CONSUMPTION_UNJOURNALED: 'Pemakaian tanpa jurnal',
  RL_UNLINKED: 'RL belum tertaut',
  RL_OVER_REFERENCE_UNAPPROVED: 'Melebihi acuan tanpa alasan',
  PBL_MUTATING_WITH_RL: 'PBL memotong stok + RL',
  LOT_DEFAULT_EXPIRY: 'Lot kedaluwarsa default',
  PRODUCT_DUPLICATE_KODE: 'Kode produk ganda',
  RECIPE_CONVERSION_UNVERIFIED: 'Konversi resep belum valid',
  ADJUSTMENT_NO_INDEPENDENT_APPROVAL: 'Penyesuaian tanpa penyetuju lain',
  RL_SELF_APPROVED: 'RL disetujui pembuatnya',
  INVOICE_EXCEPTION_POSTED: 'Tagihan EXCEPTION berjurnal',
};

/** Worklist tempat temuan diperbaiki lewat dokumen koreksi. */
function worklistHref(f: ReconFinding): { href: string; label: string } | null {
  switch (f.refType) {
    case 'PRODUCT':
      if (f.kind === 'PRODUCT_DUPLICATE_KODE') return { href: '/produk', label: 'Master produk' };
      return f.refId ? { href: `/stok/kartu?productId=${encodeURIComponent(f.refId)}`, label: 'Kartu stok' } : null;
    case 'PO':
      return { href: '/pembelian-po', label: 'Pembelian PO' };
    case 'GRN':
      return { href: '/penerimaan', label: 'Penerimaan' };
    case 'HUTANG':
      return { href: '/hutang', label: 'Hutang' };
    case 'RELEASE':
      return { href: '/stok/pengeluaran?mode=operasional', label: 'Pengeluaran (RL)' };
    case 'MATERIAL_ISSUE':
      return { href: '/food-production/issue', label: 'Pengambilan bahan' };
    case 'PLAN':
      return f.refId
        ? { href: `/food-production/plan?productionPlanId=${encodeURIComponent(f.refId)}`, label: 'Rencana' }
        : null;
    case 'ADJUSTMENT':
      return { href: '/stok/penyesuaian', label: 'Penyesuaian' };
    case 'RECIPE':
      return { href: '/food-production/recipe/konversi', label: 'Review konversi' };
    default:
      return null;
  }
}

function MismatchBadge({ n, status }: { n: number; status?: string }) {
  if (status === 'ERROR') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive"><AlertTriangle className="h-3.5 w-3.5" /> Error</span>;
  }
  if (status === 'SKIPPED') return <span className="text-xs text-muted-foreground">Dilewati</span>;
  return n > 0 ? (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700"><AlertTriangle className="h-3.5 w-3.5" /> {formatNumber(n)}</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700"><CheckCircle2 className="h-3.5 w-3.5" /> 0</span>
  );
}

function ReportFindings({ report }: { report: ReportRow }) {
  const router = useRouter();
  const { data, isLoading, isError } = useApiQuery<ReconReport>(
    queryKeys.ops.reconReport(report.id),
    `/api/ops/recon/report?id=${encodeURIComponent(report.id)}`,
  );
  const open = async (href: string) => {
    await setActingTenantId(report.tenantId);
    router.push(href);
  };
  if (isLoading) return <p className="text-xs text-muted-foreground p-3">Memuat temuan…</p>;
  if (isError || !data) return <p className="text-xs text-destructive p-3">Gagal memuat laporan.</p>;
  if (data.error) return <p className="text-xs text-destructive p-3">{data.error}</p>;
  if (data.skippedReason) return <p className="text-xs text-muted-foreground p-3">{data.skippedReason}</p>;
  if (!data.findings.length) return <p className="text-xs text-muted-foreground p-3">Tidak ada anomali.</p>;
  return (
    <div className="p-3 space-y-2">
      {data.truncated && (
        <p className="text-xs text-amber-700">
          Menampilkan {data.findings.length} dari {formatNumber(data.totalMismatch)} temuan.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 pr-2">Jenis</th>
              <th className="py-1 pr-2">Dokumen / produk</th>
              <th className="py-1 pr-2">Keterangan</th>
              <th className="py-1 pr-2 text-right">Selisih</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {data.findings.map((f, i) => {
              const link = worklistHref(f);
              return (
                <tr key={`${f.kind}-${f.refId}-${f.lokasiKode}-${i}`} className="border-t align-top">
                  <td className="py-1 pr-2 whitespace-nowrap">{KIND_LABEL[f.kind] || f.kind}</td>
                  <td className="py-1 pr-2">
                    {f.refNo || f.kode || f.refId || '—'}
                    {f.nama && <div className="text-muted-foreground">{f.nama}</div>}
                  </td>
                  <td className="py-1 pr-2">{f.detail}</td>
                  <td className="py-1 pr-2 text-right whitespace-nowrap">{f.delta != null ? formatNumber(f.delta) : '—'}</td>
                  <td className="py-1 whitespace-nowrap">
                    {link && (
                      <button type="button" className="text-primary inline-flex items-center gap-1" onClick={() => void open(link.href)}>
                        {link.label} <ExternalLink className="h-3 w-3" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ReconPanel() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data, isLoading, isError, refetch } = useApiQuery<ReconOverview>(
    queryKeys.ops.recon,
    '/api/ops/recon',
    { refetchInterval: 60_000 },
  );
  const run = useApiMutation([queryKeys.ops.recon]);

  const byTenant = useMemo(() => {
    const map = new Map<string, Partial<Record<ReconJob, ReportRow>>>();
    for (const r of data?.reports || []) {
      const row = map.get(r.tenantId) || {};
      row[r.job] = r;
      map.set(r.tenantId, row);
    }
    const weight = (row: Partial<Record<ReconJob, ReportRow>>) =>
      Object.values(row).reduce((s, r) => s + (r?.totalMismatch || 0) + (r?.status === 'ERROR' ? 1e9 : 0), 0);
    return [...map.entries()].sort((a, b) => weight(b[1]) - weight(a[1]) || a[0].localeCompare(b[0]));
  }, [data?.reports]);
  const jobs = data?.jobs || [...RECON_JOBS];
  const totalAll = Object.values(data?.totals || {}).reduce((s, n) => s + (Number(n) || 0), 0);

  const trigger = async (body: { job: string; tenantId?: string; allTenants?: boolean }) => {
    try {
      const res = await run.mutateAsync({ url: '/api/ops/recon/run', method: 'POST', body, offlineLabel: 'Rekonsiliasi' }) as {
        enqueued?: boolean; jobId?: string; totalMismatch?: number; errors?: number;
      };
      toast.success(res.enqueued
        ? `Rekonsiliasi semua tenant diantrikan (${res.jobId || '—'})`
        : `Selesai · ${formatNumber(res.totalMismatch || 0)} anomali${res.errors ? ` · ${res.errors} error` : ''}`);
      void refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Rekonsiliasi gagal');
    }
  };

  return (
    <section className="rounded-lg border p-4 space-y-4" data-testid="recon-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">Rekonsiliasi harian (Fase 6)</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Terjadwal tiap malam per tenant. Perbaikan lewat dokumen koreksi di worklist yang ditautkan.
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" className="gap-2" disabled={run.isPending}
          onClick={() => void trigger({ job: 'all', allTenants: true })}>
          <Play className="h-3.5 w-3.5" /> Jalankan semua tenant
        </Button>
      </div>

      {isError && <p className="text-sm text-destructive">Gagal memuat rekonsiliasi.</p>}
      {isLoading && <p className="text-sm text-muted-foreground">Memuat…</p>}

      {data && (
        <>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {jobs.map((job) => (
              <div key={job} className="rounded border p-3">
                <div className="text-xs text-muted-foreground mb-1">{JOB_LABEL[job]}</div>
                <ul className="space-y-0.5">
                  {(data.kinds[job] || []).map((kind) => (
                    <li key={kind} className="flex items-center justify-between text-xs">
                      <span>{KIND_LABEL[kind] || kind}</span>
                      <MismatchBadge n={Number(data.totals[kind] || 0)} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {!byTenant.length ? (
            <p className="text-sm text-muted-foreground">Belum ada laporan. Jalankan rekonsiliasi atau tunggu jadwal malam.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-2">Tenant</th>
                    {jobs.map((job) => <th key={job} className="py-1 pr-2">{JOB_LABEL[job]}</th>)}
                    <th className="py-1" />
                  </tr>
                </thead>
                <tbody>
                  {byTenant.map(([tenantId, row]) => (
                    <Fragment key={tenantId}>
                      <tr className="border-t">
                        <td className="py-1.5 pr-2 font-mono text-xs">{tenantId}</td>
                        {jobs.map((job) => {
                          const r = row[job];
                          const key = r ? r.id : '';
                          return (
                            <td key={job} className="py-1.5 pr-2">
                              {r ? (
                                <button type="button" className="inline-flex items-center gap-1"
                                  title={`Dijalankan ${formatDateTime(r.createdAt)} · ${r.durationMs} ms`}
                                  onClick={() => setExpanded(expanded === key ? null : key)}>
                                  {expanded === key ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                  <MismatchBadge n={r.totalMismatch} status={r.status} />
                                </button>
                              ) : <span className="text-xs text-muted-foreground">—</span>}
                            </td>
                          );
                        })}
                        <td className="py-1.5 text-right">
                          <Button type="button" size="sm" variant="ghost" disabled={run.isPending}
                            onClick={() => void trigger({ job: 'all', tenantId })}>
                            Jalankan
                          </Button>
                        </td>
                      </tr>
                      {jobs.map((job) => {
                        const r = row[job];
                        if (!r || expanded !== r.id) return null;
                        return (
                          <tr key={`${tenantId}-${job}-detail`} className="bg-muted/30">
                            <td colSpan={jobs.length + 2}>
                              <ReportFindings report={r} />
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">Total anomali terbaru: {formatNumber(totalAll)}</p>
        </>
      )}
    </section>
  );
}
