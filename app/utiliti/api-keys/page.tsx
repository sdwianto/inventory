'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';

interface KeyRow {
  id: string;
  label?: string;
  scopes?: string[];
  aktif?: boolean;
  createdAt?: string;
}

export default function ApiKeysPage() {
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState('FP Integration');
  const [scopeRead, setScopeRead] = useState(true);
  const [createdKey, setCreatedKey] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/api-keys', { headers: { ...actingTenantHeaders() } });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal memuat');
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function create() {
    setSaving(true);
    setCreatedKey('');
    try {
      const scopes = scopeRead
        ? ['food-production:read']
        : ['integrations', 'food-production:read'];
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ label, scopes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal');
      setCreatedKey(String(data.apiKey || ''));
      toast.success('API key dibuat — salin sekarang');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function revoke(id: string) {
    const res = await fetch(`/api/api-keys/${id}`, {
      method: 'DELETE',
      headers: { ...actingTenantHeaders() },
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal');
      return;
    }
    toast.success('API key dinonaktifkan');
    await load();
  }

  return (
    <div className="space-y-4 p-4 md:p-6 max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            API Keys
          </h1>
          <p className="text-sm text-muted-foreground">
            Integrasi eksternal — scope <code className="text-xs">food-production:read</code> untuk{' '}
            <code className="text-xs">/api/fp-public/*</code>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4 mr-1" /> Muat
        </Button>
      </div>

      <div className="rounded-md border p-4 space-y-3">
        <div className="space-y-1">
          <Label>Label</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <label className="text-sm flex items-center gap-2">
          <input type="checkbox" checked={scopeRead} onChange={(e) => setScopeRead(e.target.checked)} />
          Scope food-production:read
        </label>
        <Button size="sm" onClick={() => void create()} disabled={saving}>
          <Plus className="h-4 w-4 mr-1" /> Buat key
        </Button>
        {createdKey && (
          <div className="rounded border bg-amber-50 p-3 text-xs break-all">
            <strong>Salin sekarang:</strong> {createdKey}
          </div>
        )}
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Label</th>
              <th className="text-left p-3">Scopes</th>
              <th className="text-left p-3">Aktif</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-3">{row.label}</td>
                <td className="p-3 text-xs font-mono">{(row.scopes || []).join(', ')}</td>
                <td className="p-3">{row.aktif === false ? 'Nonaktif' : 'Aktif'}</td>
                <td className="p-3 text-right">
                  {row.aktif !== false && (
                    <Button size="sm" variant="ghost" onClick={() => void revoke(row.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
