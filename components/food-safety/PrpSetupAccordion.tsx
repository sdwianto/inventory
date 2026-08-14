'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { ArrowRight, Check, Circle } from 'lucide-react';
import {
  BGN_HACCP_SOURCE,
  PRP_EVIDENCE_TYPE_LABELS,
  PRP_GROUP_BLURB,
  PRP_GROUP_LABELS,
  PRP_GROUP_ORDER,
  buildPrpRecordHref,
  groupRequirementsByPre,
  type PrpEvidenceType,
  type PrpRequirementGroup,
} from '@/lib/food-safety/prp-meta';

type ReqRow = {
  id: string;
  kode: string;
  nama: string;
  programId: string;
  programKode?: string;
  requirementGroup?: string;
  bgnCode?: string;
  evidenceType?: string;
};

type ComplianceRow = {
  requirementId: string;
  status: 'RECORDED' | 'MISSING';
};

export default function PrpSetupAccordion() {
  const [reqs, setReqs] = useState<ReqRow[]>([]);
  const [compliance, setCompliance] = useState<ComplianceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [openGroup, setOpenGroup] = useState<PrpRequirementGroup | null>('PRE-04');
  const [highlightId, setHighlightId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const hdr = { ...actingTenantHeaders(), ...actingKitchenHeaders() };
      const [rRes, cRes] = await Promise.all([
        fetch('/api/food-safety-requirements?aktif=1', { headers: hdr }),
        fetch('/api/food-safety-requirements/compliance', { headers: hdr }),
      ]);
      const rData = await rRes.json();
      const cData = await cRes.json();
      if (!rRes.ok) throw new Error(rData.error || 'Gagal memuat prasyarat');
      setReqs(Array.isArray(rData) ? rData : (rData.items || []));
      setCompliance(Array.isArray(cData?.rows) ? cData.rows : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search);
    const g = String(q.get('group') || '').toUpperCase() as PrpRequirementGroup;
    if (PRP_GROUP_ORDER.includes(g)) setOpenGroup(g);
    const rid = q.get('requirementId') || '';
    if (rid) setHighlightId(rid);
  }, []);

  const recordedIds = useMemo(
    () => new Set(compliance.filter((c) => c.status === 'RECORDED').map((c) => c.requirementId)),
    [compliance],
  );

  const grouped = useMemo(() => groupRequirementsByPre(reqs), [reqs]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-semibold">1. Checklist prasyarat dapur</h2>
          <p className="text-sm text-muted-foreground">
            Lima kelompok seperti pekerjaan rumah tangga dapur — bukan kode teknis.
          </p>
        </div>
        <a
          href={BGN_HACCP_SOURCE.href}
          className="text-xs text-blue-700 hover:underline"
          title={BGN_HACCP_SOURCE.path}
        >
          Dasar aturan: {BGN_HACCP_SOURCE.label}
        </a>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Memuat checklist…</p>}

      <div className="space-y-2">
        {PRP_GROUP_ORDER.map((g) => {
          const items = grouped[g];
          const done = items.filter((i) => recordedIds.has(i.id)).length;
          const isOpen = openGroup === g;
          return (
            <div key={g} className="rounded-lg border bg-white">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
                onClick={() => setOpenGroup(isOpen ? null : g)}
              >
                <div>
                  <div className="font-medium text-sm">{PRP_GROUP_LABELS[g]}</div>
                  <div className="text-xs text-muted-foreground">{PRP_GROUP_BLURB[g]}</div>
                </div>
                <div className="shrink-0 text-xs text-muted-foreground">
                  {done}/{items.length} ada
                </div>
              </button>
              {isOpen && (
                <ul className="border-t divide-y">
                  {items.length === 0 && (
                    <li className="px-4 py-3 text-sm text-muted-foreground">Belum ada item di grup ini.</li>
                  )}
                  {items.map((item) => {
                    const ada = recordedIds.has(item.id);
                    const ev = (item.evidenceType || 'CHECKLIST') as PrpEvidenceType;
                    const href = buildPrpRecordHref({
                      programId: item.programId,
                      requirementId: item.id,
                    });
                    const highlight = highlightId === item.id;
                    return (
                      <li
                        key={item.id}
                        className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 ${
                          highlight ? 'bg-amber-50' : ''
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 text-sm">
                            {ada ? (
                              <Check className="h-3.5 w-3.5 text-emerald-600" />
                            ) : (
                              <Circle className="h-3.5 w-3.5 text-amber-500" />
                            )}
                            <span className="font-medium">{item.nama}</span>
                          </div>
                          <div className="pl-5 text-[11px] text-muted-foreground">
                            {ada ? 'Ada catatan periode ini' : 'Belum'}
                            {item.bgnCode ? ` · ${item.bgnCode}` : ''}
                            {` · ${PRP_EVIDENCE_TYPE_LABELS[ev] || ev}`}
                          </div>
                        </div>
                        <Button asChild size="sm" variant={ada ? 'outline' : 'default'}>
                          <Link href={href}>
                            Catat sekarang
                            <ArrowRight className="ml-1 h-4 w-4" />
                          </Link>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
