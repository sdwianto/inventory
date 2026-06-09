/** Ekspor CSV ringan — tanpa dependensi Excel/PDF. */

function cellValue(row, column) {
  const raw = typeof column.value === 'function' ? column.value(row) : row[column.key];
  return raw ?? '';
}

function escapeCsvCell(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** @param {string} filename @param {object[]} rows @param {{ key: string, label: string, value?: (row: object) => string|number }[]} columns */
export function downloadCsv(filename, rows, columns) {
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
