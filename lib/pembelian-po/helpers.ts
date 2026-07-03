import type { JsonObject } from '@/types/json';
import { str, asObject, asArray } from '@/types/json';

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

function vendorLabel(vendorTenantId: string, vendorNameById: Record<string, string>): string {
  const vid = vendorTenantId.trim();
  if (!vid) return 'Vendor';
  return vendorNameById[vid] || vid;
}

/** Tampilan SO per vendor — mis. "Zulmy: SO2607000001 · UD Dawam: SO2607000002" */
export function formatPoVendorSoDisplay(
  po: JsonObject | null | undefined,
  vendorNameById: Record<string, string> = {},
): string {
  if (!po) return '';
  const subs = asArray(po.vendorSubmissions) as JsonObject[];
  if (subs.length) {
    return subs
      .map((s) => {
        const name = vendorLabel(str(s.vendorTenantId), vendorNameById);
        const no = str(s.vendorNoSO);
        return no ? `${name}: ${no}` : name;
      })
      .join(' · ');
  }
  const no = str(po.vendorNoSO);
  if (!no) return '';
  const vid = str(po.vendorTenantId);
  if (vid && vid !== 'multi') {
    return `${vendorLabel(vid, vendorNameById)}: ${no}`;
  }
  return no;
}
