/** Kolom tenant + lokasi gudang untuk tabel & export list operasional. */

import type { ExportColumn } from '@/types/client';

export const SCOPE_COLUMNS: ExportColumn[] = [
  { key: 'tenantName', label: 'Tenant' },
  { key: 'lokasi', label: 'Lokasi Gudang' },
];

export function withScopeColumns(columns: ExportColumn[]): ExportColumn[] {
  return [...SCOPE_COLUMNS, ...columns];
}

type ScopeValueFn = (row: Record<string, unknown>) => string | number;

export function scopeExportColumns(
  extra: Partial<Record<string, ScopeValueFn>> = {},
): ExportColumn[] {
  return SCOPE_COLUMNS.map((col) => ({
    ...col,
    ...(extra[col.key] ? { value: extra[col.key] } : {}),
  }));
}
