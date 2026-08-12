/**
 * Batch audit trail compose + CSV — ADR-001 Phase 5 / Sprint 21.
 */

function csvEscape(value: unknown): string {
  let s = value == null ? '' : String(value);
  // Neutralize formula injection when opened in Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export type BatchTrailEventType =
  | 'BATCH'
  | 'PLAN'
  | 'RESULT'
  | 'TEMP_LOG'
  | 'QC'
  | 'HACCP'
  | 'FOOD_SAFETY'
  | 'AUDIT';

export interface BatchTrailEvent {
  at: string;
  eventType: BatchTrailEventType;
  entityType: string;
  entityId: string;
  refNo?: string;
  summary: string;
  statusOrAlert?: string;
  evidenceUrl?: string;
  userName?: string;
}

export interface BatchAuditTrail {
  batch: {
    id: string;
    batchNo?: string;
    status?: string;
    /** ADR-004 — disposisi food safety (HOLD memblokir FEFO). */
    foodSafetyStatus?: string;
    kitchenNama?: string;
    productionPlanId?: string;
    productionPlanNo?: string;
    productionResultId?: string;
    productionResultNo?: string;
    expiryDate?: string;
    finishedGoodNama?: string;
  };
  events: BatchTrailEvent[];
}

export function batchTrailToCsv(trail: BatchAuditTrail): string {
  const header = [
    'batchId',
    'batchNo',
    'at',
    'eventType',
    'entityType',
    'entityId',
    'refNo',
    'summary',
    'statusOrAlert',
    'evidenceUrl',
    'userName',
  ];
  const lines = [header.join(',')];
  for (const ev of trail.events) {
    lines.push([
      trail.batch.id,
      trail.batch.batchNo || '',
      ev.at,
      ev.eventType,
      ev.entityType,
      ev.entityId,
      ev.refNo || '',
      ev.summary,
      ev.statusOrAlert || '',
      ev.evidenceUrl || '',
      ev.userName || '',
    ].map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function sortTrailEvents(events: BatchTrailEvent[]): BatchTrailEvent[] {
  const normalizeAt = (at: string) => {
    const s = String(at || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
    return s;
  };
  return [...events].sort((a, b) => normalizeAt(a.at).localeCompare(normalizeAt(b.at)));
}
