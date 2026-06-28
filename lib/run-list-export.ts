import { downloadCsv } from '@/lib/export-csv';
import type { ExportColumn } from '@/types/client';

export type ListExportFormat = 'csv' | 'xlsx' | 'pdf';

export interface ListExportOptions {
  baseName: string;
  title: string;
  sheetName?: string;
  columns: ExportColumn[];
  rows: Record<string, unknown>[];
}

export async function runListExport(
  format: ListExportFormat,
  { baseName, title, sheetName, columns, rows }: ListExportOptions,
): Promise<void> {
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
