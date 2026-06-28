/** Ekspor CSV ringan — tanpa dependensi Excel/PDF. */

import type { ExportColumn } from '@/types/client';

function cellValue(row: Record<string, unknown>, column: ExportColumn): string | number {
  const raw = typeof column.value === 'function' ? column.value(row) : row[column.key];
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string' || typeof raw === 'number') return raw;
  return String(raw);
}

function escapeCsvCell(value: string | number): string {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function downloadCsv(
  filename: string,
  rows: Record<string, unknown>[],
  columns: ExportColumn[],
): void {
  const header = columns.map((c) => escapeCsvCell(c.label)).join(',');
  const body = rows.map((row) =>
    columns.map((c) => escapeCsvCell(cellValue(row, c))).join(','),
  );
  const csv = `\uFEFF${header}\n${body.join('\n')}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
