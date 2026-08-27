import { asObject, num, str, type JsonObject } from '@/types/json';
import { lineUomKey } from '@/lib/uom/line-ui';

export type ReleaseFormItem = {
  stokId: string;
  kode: string;
  nama: string;
  uomId: string;
  satuan: string;
  qty: number;
  stokAvail: number;
  stokByWarehouse: Record<string, unknown>;
  /** Key lokal untuk patch UOM setelah add optimistic. */
  clientKey?: string;
};

export function qtyAtLokasi(p: JsonObject, lokasiKode: string): number {
  const byWh = asObject(p.stokByWarehouse);
  const kode = lokasiKode.trim().toUpperCase();
  if (kode && kode in byWh) return num(byWh[kode]);
  return num(p.stokQty ?? p.stokTotal);
}

/** Label tampilan: form state → katalog saldo → kode → 'Produk'. */
export function resolveReleaseItemDisplay(
  it: JsonObject,
  catalog: Map<string, JsonObject>,
  lokasiKode: string,
): { nama: string; kode: string; stokAvail: number } {
  const fromCatalog = catalog.get(str(it.stokId));
  const kode = str(it.kode).trim() || str(fromCatalog?.kode).trim();
  const nama = str(it.nama).trim() || str(fromCatalog?.nama).trim() || kode || 'Produk';
  const catalogWh = asObject(fromCatalog?.stokByWarehouse);
  const stokSource =
    fromCatalog && Object.keys(catalogWh).length > 0 ? fromCatalog : it;
  return {
    nama,
    kode,
    stokAvail: qtyAtLokasi(stokSource, lokasiKode),
  };
}

/** Snapshot field produk ke primitif — aman dipakai setelah `await`. */
export function snapshotProductLabels(p: JsonObject): {
  stokId: string;
  kode: string;
  nama: string;
  satuan: string;
  stokByWarehouse: Record<string, unknown>;
  stokQty: unknown;
  stokTotal: unknown;
} {
  return {
    stokId: str(p.id).trim(),
    kode: str(p.kode).trim(),
    nama: str(p.nama).trim(),
    satuan: str(p.satuan).trim(),
    stokByWarehouse: { ...asObject(p.stokByWarehouse) },
    stokQty: p.stokQty,
    stokTotal: p.stokTotal,
  };
}

export function buildReleaseFormItem(args: {
  product: JsonObject;
  lokasiKode: string;
  uomId?: string;
  satuan?: string;
  qty?: number;
  clientKey?: string;
}): ReleaseFormItem | null {
  const snap = snapshotProductLabels(args.product);
  if (!snap.stokId) return null;
  return {
    stokId: snap.stokId,
    kode: snap.kode,
    nama: snap.nama,
    uomId: str(args.uomId),
    satuan: str(args.satuan) || snap.satuan,
    qty: args.qty ?? 1,
    stokAvail: qtyAtLokasi(
      {
        stokByWarehouse: snap.stokByWarehouse,
        stokQty: snap.stokQty,
        stokTotal: snap.stokTotal,
      },
      args.lokasiKode,
    ),
    stokByWarehouse: snap.stokByWarehouse,
    ...(args.clientKey ? { clientKey: args.clientKey } : {}),
  };
}

export function appendReleaseFormItem(
  items: ReleaseFormItem[],
  next: ReleaseFormItem,
): { items: ReleaseFormItem[]; duplicate: boolean } {
  const key = lineUomKey(next.stokId, next.uomId);
  if (items.some((it) => lineUomKey(it.stokId, it.uomId) === key)) {
    return { items, duplicate: true };
  }
  // Cegah dobel klik sebelum UOM ter-resolve (clientKey pending, uomId kosong).
  if (
    !next.uomId
    && items.some((it) => it.stokId === next.stokId && !it.uomId)
  ) {
    return { items, duplicate: true };
  }
  return { items: [...items, next], duplicate: false };
}

export function patchReleaseFormItemUom(
  items: ReleaseFormItem[],
  clientKey: string,
  uom: { id: string; satuan: string },
): { items: ReleaseFormItem[]; duplicate: boolean } {
  const target = items.find((it) => it.clientKey === clientKey);
  if (!target) return { items, duplicate: false };

  const nextKey = lineUomKey(target.stokId, uom.id);
  const conflict = items.some(
    (it) => it.clientKey !== clientKey && lineUomKey(it.stokId, it.uomId) === nextKey,
  );
  if (conflict) {
    return {
      items: items.filter((it) => it.clientKey !== clientKey),
      duplicate: true,
    };
  }

  return {
    duplicate: false,
    items: items.map((it) => {
      if (it.clientKey !== clientKey) return it;
      return {
        ...it,
        uomId: uom.id,
        satuan: uom.satuan || it.satuan,
        // Re-assert label — jangan biarkan patch UOM mengosongkan nama.
        nama: it.nama.trim() || it.kode || 'Produk',
        kode: it.kode,
        clientKey: undefined,
      };
    }),
  };
}

/** Isi nama/kode kosong dari katalog (setelah saldo load). */
export function backfillReleaseItemLabels(
  items: ReleaseFormItem[],
  catalog: Map<string, JsonObject>,
): { items: ReleaseFormItem[]; changed: boolean } {
  let changed = false;
  const next = items.map((it) => {
    if (it.nama.trim()) return it;
    const cat = catalog.get(it.stokId);
    if (!cat) return it;
    const nama = str(cat.nama).trim();
    const kode = it.kode.trim() || str(cat.kode).trim();
    if (!nama && !kode) return it;
    changed = true;
    const catWh = asObject(cat.stokByWarehouse);
    return {
      ...it,
      nama: nama || kode,
      kode,
      stokByWarehouse: Object.keys(it.stokByWarehouse).length
        ? it.stokByWarehouse
        : { ...catWh },
    };
  });
  return { items: next, changed };
}

export function catalogFromSaldoRows(rows: JsonObject[]): Map<string, JsonObject> {
  const map = new Map<string, JsonObject>();
  for (const p of rows) {
    const id = str(p.id).trim();
    if (id) map.set(id, p);
  }
  return map;
}
