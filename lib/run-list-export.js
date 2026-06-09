import { downloadCsv } from '@/lib/export-csv';

/**
 * @param {'csv'|'xlsx'|'pdf'} format
 * @param {{ baseName: string, title: string, sheetName?: string, columns: object[], rows: object[] }} opts
 */
export async function runListExport(format, { baseName, title, sheetName, columns, rows }) {
  if (!rows?.length) throw new Error('Tidak ada data untuk diekspor');
  if (format === 'csv') {
    downloadCsv(`${baseName}.csv`, rows, columns);
  } else if (format === 'xlsx') {
    const { downloadExcel } = await import('@/lib/export-table');
    downloadExcel(`${baseName}.xlsx`, rows, columns, sheetName || title);
  } else {
    const { downloadPdf } = await import('@/lib/export-table');
    downloadPdf(`${baseName}.pdf`, title, rows, columns);
  }
}
