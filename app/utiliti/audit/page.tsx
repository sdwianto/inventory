'use client';

import { useMemo, useState } from 'react';
import { Shield, Search, ChevronRight, Download } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { queryKeys } from '@/lib/query-keys';
import { formatDateTime } from '@/lib/format';

type AuditRow = {
  id: string;
  tenantId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  summary?: string;
  userName?: string;
  createdAt?: string;
};

type AuditResponse = {
  items: AuditRow[];
  hasMore?: boolean;
  nextCursor?: string | null;
  retentionDays?: number;
};

export default function AuditLogPage() {
  const [tenantId, setTenantId] = useState('');
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [complianceScope, setComplianceScope] = useState(false);

  const params = useMemo(() => {
    const sp = new URLSearchParams({ pageMode: 'cursor', limit: '50' });
    if (complianceScope) sp.set('scope', 'compliance');
    if (tenantId.trim()) sp.set('tenantId', tenantId.trim());
    if (action.trim()) sp.set('action', action.trim());
    if (q.trim()) sp.set('q', q.trim());
    if (cursor) sp.set('cursor', cursor);
    return sp.toString();
  }, [tenantId, action, q, cursor, complianceScope]);

  const { data, isLoading, isError, refetch, isFetching } = useApiQuery<AuditResponse>(
    queryKeys.audit.list({ tenantId, action, q, cursor }),
    `/api/audit-log?${params}`,
  );

  const exportCsv = () => {
    const sp = new URLSearchParams({ export: 'csv' });
    if (complianceScope) sp.set('scope', 'compliance');
    if (tenantId.trim()) sp.set('tenantId', tenantId.trim());
    if (action.trim()) sp.set('action', action.trim());
    if (q.trim()) sp.set('q', q.trim());
    window.open(`/api/audit-log?${sp.toString()}`, '_blank');
  };

  const items = data?.items ?? [];

  const applySearch = () => {
    setCursor(null);
    setCursors([null]);
    void refetch();
  };

  const nextPage = () => {
    if (!data?.nextCursor) return;
    setCursors((prev) => [...prev, data.nextCursor!]);
    setCursor(data.nextCursor);
  };

  const prevPage = () => {
    if (cursors.length <= 1) return;
    const next = cursors.slice(0, -1);
    setCursors(next);
    setCursor(next[next.length - 1] ?? null);
  };

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Shield className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Audit Log</h1>
            <p className="text-sm text-muted-foreground">
              MASTER — mutasi stok &amp; maintenance (
              {complianceScope ? 'compliance 7 tahun' : `${data?.retentionDays ?? 90} hari UI`}
              )
            </p>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={exportCsv} className="gap-2">
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={complianceScope}
          onChange={(e) => {
            setComplianceScope(e.target.checked);
            setCursor(null);
            setCursors([null]);
          }}
        />
        Jendela compliance (7 tahun) — untuk audit eksternal
      </label>

      <div className="grid gap-3 sm:grid-cols-4">
        <Input placeholder="Tenant ID" value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
        <Input placeholder="Action (mis. GRN_POSTED)" value={action} onChange={(e) => setAction(e.target.value)} />
        <Input placeholder="Cari summary / entity / user" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="button" onClick={applySearch} className="gap-2">
          <Search className="h-4 w-4" />
          Filter
        </Button>
      </div>

      {isError && (
        <p className="text-sm text-destructive">Gagal memuat audit log — pastikan role MASTER.</p>
      )}

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-2 font-medium">Waktu</th>
              <th className="text-left p-2 font-medium">Tenant</th>
              <th className="text-left p-2 font-medium">Action</th>
              <th className="text-left p-2 font-medium">Ringkasan</th>
              <th className="text-left p-2 font-medium">User</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={5} className="p-4 text-muted-foreground">Memuat…</td></tr>
            )}
            {!isLoading && items.length === 0 && (
              <tr><td colSpan={5} className="p-4 text-muted-foreground">Tidak ada entri.</td></tr>
            )}
            {items.map((row) => (
              <tr key={row.id} className="border-t hover:bg-muted/30">
                <td className="p-2 whitespace-nowrap">{formatDateTime(row.createdAt)}</td>
                <td className="p-2 font-mono text-xs">{row.tenantId || '—'}</td>
                <td className="p-2 font-mono text-xs">{row.action || '—'}</td>
                <td className="p-2">
                  <div>{row.summary || '—'}</div>
                  {(row.entityType || row.entityId) && (
                    <div className="text-xs text-muted-foreground">
                      {row.entityType}{row.entityId ? ` · ${row.entityId}` : ''}
                    </div>
                  )}
                </td>
                <td className="p-2">{row.userName || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="outline" disabled={cursors.length <= 1 || isFetching} onClick={prevPage}>
          Sebelumnya
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!data?.hasMore || isFetching}
          onClick={nextPage}
          className="gap-1"
        >
          Berikutnya
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
