/** Flatten dokumen multi-baris ke satu baris per item — export & laporan detail. */

export type FlattenedLineFields = Record<string, string | number | undefined>;

export function flattenDocItemLines<T extends Record<string, unknown>>(
  docs: T[],
  mapLine: (line: Record<string, unknown>, doc: T) => FlattenedLineFields,
  opts?: { itemsKey?: string; includeEmptyDocs?: boolean },
): Array<T & FlattenedLineFields> {
  const key = opts?.itemsKey ?? 'items';
  const rows: Array<T & FlattenedLineFields> = [];
  for (const doc of docs) {
    const lines = (doc[key] as Array<Record<string, unknown>> | undefined) || [];
    if (!lines.length) {
      if (opts?.includeEmptyDocs) rows.push(doc as T & FlattenedLineFields);
      continue;
    }
    for (const line of lines) {
      rows.push({ ...doc, ...mapLine(line, doc) });
    }
  }
  return rows;
}

function num(v: unknown, fallback = 0): number {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback = ''): string {
  return v == null || v === '' ? fallback : String(v);
}

export function flattenTransferDocLines<T extends Record<string, unknown>>(docs: T[]) {
  return flattenDocItemLines(docs, (line) => ({
    itemKode: str(line.kode),
    itemNama: str(line.nama),
    itemSatuan: str(line.satuan, '—'),
    itemQty: num(line.qty),
    itemQtyBase: num(line.qtyBase, num(line.qty)),
  }));
}

export function flattenPenyesuaianDocLines<T extends Record<string, unknown>>(docs: T[]) {
  return flattenDocItemLines(docs, (line) => ({
    itemKode: str(line.kode),
    itemNama: str(line.nama),
    itemSatuan: str(line.satuan, '—'),
    itemQtySistem: num(line.qtySistem),
    itemQtyAktual: num(line.qtyEntered ?? line.qtyAktual),
    itemSelisih: num(line.selisih),
  }));
}
