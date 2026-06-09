/** Ekspor tabel ke CSV, Excel (.xlsx), atau PDF — client-side. */

import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

/**
 * @typedef {{ key: string, label: string, value?: (row: object) => string|number }} ExportColumn
 */

function cellValue(row, column) {
  const raw = typeof column.value === 'function' ? column.value(row) : row[column.key];
  return raw ?? '';
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeCsvCell(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** @param {string} filename @param {object[]} rows @param {ExportColumn[]} columns */
export function downloadCsv(filename, rows, columns) {
  const header = columns.map((c) => escapeCsvCell(c.label)).join(',');
  const body = rows.map((row) =>
    columns.map((c) => escapeCsvCell(cellValue(row, c))).join(','),
  );
  const csv = `\uFEFF${header}\n${body.join('\n')}`;
  triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), filename);
}

/** @param {string} filename @param {object[]} rows @param {ExportColumn[]} columns @param {string} [sheetName] */
export function downloadExcel(filename, rows, columns, sheetName = 'Data') {
  const aoa = [
    columns.map((c) => c.label),
    ...rows.map((row) => columns.map((c) => cellValue(row, c))),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const colWidths = columns.map((col, ci) => {
    const maxLen = Math.max(
      String(col.label).length,
      ...rows.map((r) => String(cellValue(r, col)).length),
    );
    return { wch: Math.min(Math.max(maxLen + 2, 8), 40) };
  });
  ws['!cols'] = colWidths;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, filename);
}

/** @param {string} filename @param {string} title @param {object[]} rows @param {ExportColumn[]} columns */
export function downloadPdf(filename, title, rows, columns) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFontSize(14);
  doc.text(title, 14, 12);
  doc.setFontSize(9);
  doc.setTextColor(100);
  doc.text(`Diekspor: ${new Date().toLocaleString('id-ID')} · ${rows.length} baris`, 14, 18);
  doc.setTextColor(0);

  autoTable(doc, {
    head: [columns.map((c) => c.label)],
    body: rows.map((row) => columns.map((c) => String(cellValue(row, c)))),
    startY: 22,
    margin: { left: 10, right: 10 },
    styles: { fontSize: 7, cellPadding: 1.5, overflow: 'linebreak' },
    headStyles: { fillColor: [234, 88, 12], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    tableWidth: pageWidth - 20,
  });

  doc.save(filename);
}
