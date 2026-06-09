/** Kolom tenant + lokasi gudang untuk tabel & export list operasional. */

export const SCOPE_COLUMNS = [
  { key: 'tenantName', label: 'Tenant' },
  { key: 'lokasi', label: 'Lokasi Gudang' },
];

export function withScopeColumns(columns) {
  return [...SCOPE_COLUMNS, ...columns];
}

export function scopeExportColumns(extra = {}) {
  return SCOPE_COLUMNS.map((col) => ({
    ...col,
    ...(extra[col.key] ? { value: extra[col.key] } : {}),
  }));
}
