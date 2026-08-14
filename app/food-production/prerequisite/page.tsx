'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { RefreshCw, ShieldCheck, ExternalLink } from 'lucide-react';
import FoodSafetyBreadcrumb from '@/components/food-safety/FoodSafetyBreadcrumb';
import {
  FOOD_SAFETY_PROGRAM_FREQUENCY_LABELS,
  FOOD_SAFETY_PROGRAM_SOURCE_LABELS,
  type FoodSafetyProgramFrequency,
  type FoodSafetyProgramSource,
} from '@/lib/food-production/food-safety-program';

interface RequirementRow {
  id: string;
  kode: string;
  nama: string;
  source: FoodSafetyProgramSource;
  sourceRef?: string;
  aktif: boolean;
}

interface ProgramRow {
  id: string;
  kode: string;
  nama: string;
  description?: string;
  frequency: FoodSafetyProgramFrequency;
  responsibleRole?: string;
  source: FoodSafetyProgramSource;
  aktif: boolean;
  requirements?: RequirementRow[];
}

export default function PrerequisitePage() {
  const [rows, setRows] = useState<ProgramRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProgramRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/food-safety-programs?aktif=1', {
        headers: actingTenantHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat program');
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (id: string) => {
    setSelectedId(id);
    try {
      const res = await fetch(`/api/food-safety-programs/${id}`, {
        headers: actingTenantHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat detail');
      setDetail(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
      setDetail(null);
    }
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <FoodSafetyBreadcrumb
            items={[
              { href: '/kitchen-assurance/setup', label: 'Setup kesiapan' },
              { label: 'Checklist prasyarat' },
            ]}
          />
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold tracking-tight">
            <ShieldCheck className="h-5 w-5" />
            Checklist prasyarat
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Program kebersihan & fasilitas (contoh BGN). Catat lewat checklist — tidak perlu hafal istilah PRP.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-1 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Muat ulang
          </Button>
          <Button asChild size="sm">
            <Link href="/food-production/qc">
              Catat checklist
              <ExternalLink className="ml-1 h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-2 font-medium">Kode</th>
                <th className="p-2 font-medium">Program</th>
                <th className="p-2 font-medium">Frekuensi</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={`cursor-pointer border-t hover:bg-muted/30 ${
                    selectedId === row.id ? 'bg-muted/40' : ''
                  }`}
                  onClick={() => void openDetail(row.id)}
                >
                  <td className="p-2 font-mono text-xs">{row.kode}</td>
                  <td className="p-2">
                    <div className="font-medium">{row.nama}</div>
                    <div className="text-xs text-muted-foreground">
                      {FOOD_SAFETY_PROGRAM_SOURCE_LABELS[row.source]}
                      {row.responsibleRole ? ` · ${row.responsibleRole}` : ''}
                    </div>
                  </td>
                  <td className="p-2 text-xs">
                    {FOOD_SAFETY_PROGRAM_FREQUENCY_LABELS[row.frequency] || row.frequency}
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-4 text-center text-muted-foreground">
                    Belum ada program
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border p-4">
          {!detail ? (
            <p className="text-sm text-muted-foreground">Pilih program untuk melihat requirement.</p>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="font-mono text-xs text-muted-foreground">{detail.kode}</div>
                <h2 className="text-lg font-semibold">{detail.nama}</h2>
                {detail.description && (
                  <p className="mt-1 text-sm text-muted-foreground">{detail.description}</p>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                Frekuensi:{' '}
                {FOOD_SAFETY_PROGRAM_FREQUENCY_LABELS[detail.frequency] || detail.frequency}
                {' · '}
                Sumber: {FOOD_SAFETY_PROGRAM_SOURCE_LABELS[detail.source]}
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium">Requirements</h3>
                <ul className="space-y-2">
                  {(detail.requirements || []).map((req) => (
                    <li key={req.id} className="rounded border px-3 py-2 text-sm">
                      <div className="font-mono text-xs text-muted-foreground">{req.kode}</div>
                      <div className="font-medium">{req.nama}</div>
                      {req.sourceRef && (
                        <div className="text-xs text-muted-foreground">{req.sourceRef}</div>
                      )}
                    </li>
                  ))}
                  {(detail.requirements || []).length === 0 && (
                    <li className="text-sm text-muted-foreground">Belum ada requirement</li>
                  )}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
