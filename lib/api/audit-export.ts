/** CSV export audit log untuk auditor (P3 compliance). */

function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function auditRowsToCsv(rows: Record<string, unknown>[]): string {
  const header = [
    'id', 'createdAt', 'tenantId', 'action', 'entityType', 'entityId',
    'summary', 'userId', 'userName',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map((col) => csvEscape(row[col])).join(','));
  }
  return `${lines.join('\n')}\n`;
}
