/**
 * Gelombang C — antrian "Wajib hari ini" dari rencana HACCP ACTIVE.
 */

import type { HaccpCcp, HaccpMonitoringPlan } from '@/lib/food-production/haccp-plan';
import { normalizeHaccpTemplateKodeHint } from '@/lib/food-production/haccp-plan';

export type OperasiQueueItem = {
  kind: 'ccp' | 'temp' | 'prp';
  key: string;
  title: string;
  subtitle?: string;
  href: string;
};

export function buildOperasiCcpQueue(plan: {
  id: string;
  monitoringPlans?: HaccpMonitoringPlan[];
  ccps?: HaccpCcp[];
}): OperasiQueueItem[] {
  const ccpByKey = new Map((plan.ccps || []).map((c) => [c.key, c]));
  const items: OperasiQueueItem[] = [];
  for (const mon of plan.monitoringPlans || []) {
    const ccp = ccpByKey.get(mon.ccpKey);
    const templateKode = normalizeHaccpTemplateKodeHint(mon.templateKodeHint || '');
    const params = new URLSearchParams();
    params.set('create', '1');
    params.set('planId', plan.id);
    if (mon.ccpKey) params.set('ccpKey', mon.ccpKey);
    if (templateKode) params.set('templateKode', templateKode);
    items.push({
      kind: 'ccp',
      key: mon.key,
      title: ccp?.nama || mon.method || mon.key,
      subtitle: [mon.frequency, mon.responsibleRole].filter(Boolean).join(' · ') || undefined,
      href: `/food-production/haccp?${params.toString()}`,
    });
  }
  return items;
}

/** Pintu suhu + PRP — selalu ditampilkan bila ada rencana aktif. */
export function buildOperasiSupportQueue(): OperasiQueueItem[] {
  return [
    {
      kind: 'temp',
      key: 'cold-chain',
      title: 'Catat suhu rantai dingin',
      subtitle: 'Cold chain / holding',
      href: '/food-production/cold-chain',
    },
    {
      kind: 'prp',
      key: 'prp',
      title: 'Checklist prasyarat (PRP)',
      subtitle: 'Kebersihan, higiene, penerimaan',
      href: '/kitchen-assurance/setup',
    },
  ];
}
