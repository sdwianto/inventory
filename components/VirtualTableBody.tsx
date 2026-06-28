'use client';

import type { ReactNode } from 'react';

/** Render baris tabel — slice opsional untuk list sangat besar. */
export default function VirtualTableBody<T extends { id?: unknown }>({
  rows = [],
  renderRow,
  emptyRow = null,
  maxRows = 300,
}: {
  rows?: T[];
  renderRow: (row: T, index: number) => ReactNode;
  emptyRow?: ReactNode;
  maxRows?: number;
}) {
  if (!rows.length) return emptyRow;
  const visible = rows.length > maxRows ? rows.slice(0, maxRows) : rows;
  return (
    <>
      {visible.map((row, i) => renderRow(row, i))}
      {rows.length > maxRows && (
        <tr className="border-t bg-slate-50">
          <td colSpan={99} className="px-3 py-2 text-center text-xs text-slate-500">
            Menampilkan {maxRows} dari {rows.length} baris — gunakan filter periode jika tersedia
          </td>
        </tr>
      )}
    </>
  );
}
