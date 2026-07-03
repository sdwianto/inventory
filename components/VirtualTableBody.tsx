'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';

/** Di bawah ambang ini semua baris dirender langsung (tanpa windowing). */
const VIRTUALIZE_AFTER = 100;
const ROW_ESTIMATE_PX = 41;

/**
 * Render baris tabel dengan windowing sungguhan (@tanstack/react-virtual).
 * Semua data tetap bisa discroll — hanya baris yang terlihat yang dirender.
 */
export default function VirtualTableBody<T extends { id?: unknown }>({
  rows = [],
  renderRow,
  emptyRow = null,
}: {
  rows?: T[];
  renderRow: (row: T, index: number) => ReactNode;
  emptyRow?: ReactNode;
  /** @deprecated Tidak lagi memotong data; dipertahankan agar pemakai lama tetap kompatibel. */
  maxRows?: number;
}) {
  const anchorRef = useRef<HTMLTableRowElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const enabled = rows.length > VIRTUALIZE_AFTER;

  const virtualizer = useWindowVirtualizer({
    count: enabled ? rows.length : 0,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 16,
    scrollMargin,
  });

  useEffect(() => {
    if (!enabled) return;
    const el = anchorRef.current;
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      setScrollMargin((prev) => (Math.abs(prev - top) > 1 ? top : prev));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [enabled, rows.length]);

  if (!rows.length) return emptyRow;
  if (!enabled) return <>{rows.map((row, i) => renderRow(row, i))}</>;

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const padTop = items.length ? Math.max(0, items[0].start - scrollMargin) : 0;
  const padBottom = items.length
    ? Math.max(0, totalSize - (items[items.length - 1].end - scrollMargin))
    : totalSize;

  return (
    <>
      <tr ref={anchorRef} aria-hidden style={{ height: padTop }}>
        <td colSpan={99} style={{ padding: 0, border: 0 }} />
      </tr>
      {items.map((vi) => renderRow(rows[vi.index], vi.index))}
      <tr aria-hidden style={{ height: padBottom }}>
        <td colSpan={99} style={{ padding: 0, border: 0 }} />
      </tr>
    </>
  );
}
