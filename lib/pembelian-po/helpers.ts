import type { JsonObject } from '@/types/json';
import { str, asObject } from '@/types/json';

export function toDateInputValue(d: string | Date | null | undefined): string {
  if (!d) return '';
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function poCreatorLabel(po: JsonObject | null | undefined): string {
  const createdBy = asObject(po?.createdBy);
  const requestedBy = asObject(po?.requestedBy);
  return str(createdBy.userName)
    || str(createdBy.name)
    || str(createdBy.email)
    || str(requestedBy.userName)
    || 'Tidak tercatat';
}

export function mergeFormLinesFromPo(
  items: JsonObject[] | undefined,
  emptyLine: () => JsonObject,
): JsonObject[] {
  if (!items?.length) return [emptyLine()];
  const map = new Map<string, JsonObject>();
  for (const it of items) {
    const id = String(it.localStokId || '');
    if (!id) continue;
    const prev = map.get(id);
    if (prev) {
      prev.qty = (parseFloat(String(prev.qty)) || 0) + (parseFloat(String(it.qty)) || 0);
    } else {
      map.set(id, {
        localStokId: id,
        qty: it.qty,
        estimasiHarga: it.estimasiHarga || '',
        estimasiManual: true,
      });
    }
  }
  const merged = [...map.values()];
  return merged.length ? merged : [emptyLine()];
}

export function emptyPoLine(): JsonObject {
  return { localStokId: '', qty: 1, estimasiHarga: '', estimasiManual: false };
}
