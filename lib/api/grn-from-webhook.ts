import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { resolveVendorTenantName } from '@/lib/api/grn-enrich';
import { ensureUniqueLineIds } from '@/lib/api/grn-line-ids';
import { loadProductMaps, resolveFromMaps } from '@/lib/api/grn-resolve-products';
import { listProductUoms } from '@/lib/api/product-uom';
import type { ProductUom } from '@/lib/uom/types';
import type { JsonObject } from '@/types/json';

export async function resolveLocalUomForGrnLine(
  db: Db,
  tenantId: string,
  localStokId: string | null | undefined,
  vendorItem: JsonObject,
  uomsCache: Map<string, ProductUom[]>,
): Promise<{ uomId?: string; satuan?: string; qtyBase?: number; factorToBase?: number }> {
  if (!localStokId) {
    const qtyBaseFromWebhook = vendorItem.qtyBase != null
      ? parseFloat(String(vendorItem.qtyBase))
      : undefined;
    return {
      satuan: vendorItem.satuan ? String(vendorItem.satuan) : undefined,
      qtyBase: qtyBaseFromWebhook,
    };
  }
  if (!uomsCache.has(localStokId)) {
    uomsCache.set(localStokId, await listProductUoms(db, tenantId, localStokId));
  }
  const uoms = uomsCache.get(localStokId) || [];
  const vendorUomId = vendorItem.uomId ? String(vendorItem.uomId) : '';
  const qty = parseFloat(String(vendorItem.qty)) || 0;
  const qtyBaseFromWebhook = vendorItem.qtyBase != null
    ? parseFloat(String(vendorItem.qtyBase))
    : undefined;

  if (vendorUomId) {
    const local = uoms.find((u) => u.vendorUomId === vendorUomId || u.id === vendorUomId);
    if (local) {
      return {
        uomId: local.id,
        satuan: local.satuan,
        factorToBase: local.factorToBase,
        qtyBase: qtyBaseFromWebhook != null && !Number.isNaN(qtyBaseFromWebhook)
          ? qtyBaseFromWebhook
          : qty * local.factorToBase,
      };
    }
  }

  const sat = vendorItem.satuan ? String(vendorItem.satuan).trim().toUpperCase() : '';
  if (sat) {
    const bySat = uoms.find((u) => u.satuan === sat);
    if (bySat) {
      return {
        uomId: bySat.id,
        satuan: bySat.satuan,
        factorToBase: bySat.factorToBase,
        qtyBase: qtyBaseFromWebhook != null && !Number.isNaN(qtyBaseFromWebhook)
          ? qtyBaseFromWebhook
          : qty * bySat.factorToBase,
      };
    }
  }

  return {
    satuan: vendorItem.satuan ? String(vendorItem.satuan) : undefined,
    qtyBase: qtyBaseFromWebhook != null && !Number.isNaN(qtyBaseFromWebhook)
      ? qtyBaseFromWebhook
      : undefined,
  };
}

type GrnLineDraft = JsonObject & {
  lineId: string;
  vendorStokId?: unknown;
  vendorKode?: unknown;
  vendorNama?: unknown;
  localStokId?: string | null;
  localKode?: string | null;
  localNama?: string | null;
  satuan?: unknown;
  uomId?: string;
  qtyBase?: number;
  factorToBase?: number;
  qtyOrdered: number;
  qtyReceived: number;
  harga: number;
  mapStatus: string;
};

export function grnUpdateFieldsFromPayload(
  payload: JsonObject,
  vendorTenantId: string | null | undefined,
  existing: JsonObject,
): Record<string, unknown> {
  return {
    noDO: payload.noDO || existing.noDO,
    noSO: payload.noSO || existing.noSO,
    noPO: payload.noPO || existing.noPO,
    vendorTenantId: vendorTenantId || existing.vendorTenantId,
    vendorDeliverySnapshot: payload,
    updatedAt: new Date(),
  };
}

export async function buildGrnLinesFromWebhookPayload(
  db: Db,
  tenantId: string | null | undefined,
  payload: JsonObject,
  vendorTenantId: string | null | undefined,
): Promise<{ items: GrnLineDraft[]; hasUnknown: boolean }> {
  const tid = tenantId || 'default';
  const rawItems = Array.isArray(payload.items) ? payload.items as JsonObject[] : [];
  const maps = await loadProductMaps(db, tid, vendorTenantId ?? null, rawItems);
  const items: GrnLineDraft[] = [];
  const uomsCache = new Map<string, ProductUom[]>();
  let hasUnknown = false;

  for (const it of rawItems) {
    const resolved = resolveFromMaps(maps, vendorTenantId ?? null, {
      vendorKode: it.kode,
      kode: it.kode,
      vendorStokId: it.stokId,
      stokId: it.stokId,
    });
    if (!resolved.localStokId) hasUnknown = true;
    const localUom = await resolveLocalUomForGrnLine(
      db,
      tid,
      resolved.localStokId,
      it,
      uomsCache,
    );
    const qtyBaseFromWebhook = it.qtyBase != null
      ? parseFloat(String(it.qtyBase))
      : undefined;
    items.push({
      lineId: String(it.lineId || uuidv4()),
      vendorStokId: it.stokId,
      vendorKode: it.kode,
      vendorNama: it.nama,
      localStokId: resolved.localStokId,
      localKode: resolved.localKode,
      localNama: resolved.localNama,
      satuan: localUom.satuan || it.satuan,
      uomId: localUom.uomId,
      qtyBase: localUom.qtyBase ?? qtyBaseFromWebhook,
      factorToBase: localUom.factorToBase,
      qtyOrdered: parseFloat(String(it.qty)) || 0,
      qtyReceived: 0,
      harga: parseInt(String(it.harga || 0), 10),
      mapStatus: resolved.localStokId ? 'MAPPED' : 'UNKNOWN',
    });
  }

  const { items: uniqueItems } = ensureUniqueLineIds(items);
  return { items: uniqueItems as GrnLineDraft[], hasUnknown };
}

export async function buildGrnInsertDoc(
  db: Db,
  tenantId: string | null | undefined,
  payload: JsonObject,
  vendorTenantId: string | null | undefined,
  noGRN: string,
): Promise<JsonObject> {
  const tid = tenantId || 'default';
  const now = new Date();
  const { items: uniqueItems, hasUnknown } = await buildGrnLinesFromWebhookPayload(
    db,
    tid,
    payload,
    vendorTenantId,
  );

  const vendorTenantName = await resolveVendorTenantName(db, tid, vendorTenantId ?? null);

  return {
    id: uuidv4(),
    tenantId: tid,
    noGRN,
    status: hasUnknown ? 'UNKNOWN_PRODUCT' : 'DRAFT',
    source: 'WEBHOOK',
    vendorTenantId: vendorTenantId || null,
    vendorTenantName: vendorTenantName || null,
    vendorDeliveryId: payload.deliveryId,
    noDO: payload.noDO,
    noSO: payload.noSO,
    noPO: payload.noPO || null,
    vendorDeliverySnapshot: payload,
    vendorName: vendorTenantName || vendorTenantId || null,
    supplierName: vendorTenantName || null,
    lokasi: payload.lokasi,
    items: uniqueItems,
    tanggal: payload.shippedAt ? new Date(String(payload.shippedAt)) : now,
    createdAt: now,
    invoiceSyncStatus: 'NONE',
  };
}

export async function createGrnFromDelivery(
  db: Db,
  tenantId: string | null | undefined,
  payload: JsonObject,
  vendorTenantId: string | null | undefined,
): Promise<JsonObject> {
  const tid = tenantId || 'default';
  if (payload.deliveryId) {
    const existing = await db.collection('goods_receipts').findOne({
      tenantId: tid,
      vendorDeliveryId: payload.deliveryId,
    });
    if (existing) {
      const patch = grnUpdateFieldsFromPayload(
        payload,
        vendorTenantId ?? null,
        existing as JsonObject,
      ) as Record<string, unknown>;
      if (existing.status !== 'POSTED') {
        const { items, hasUnknown } = await buildGrnLinesFromWebhookPayload(
          db,
          tid,
          payload,
          vendorTenantId,
        );
        patch.items = items;
        patch.status = hasUnknown ? 'UNKNOWN_PRODUCT' : 'DRAFT';
      }
      await db.collection('goods_receipts').updateOne(
        { id: existing.id },
        { $set: patch },
      );
      return { ...existing, ...patch } as JsonObject;
    }
  }

  const noGRN = await nextDocNumber(db, tenantId, 'GRN', 'GRN');
  const doc = await buildGrnInsertDoc(db, tenantId, payload, vendorTenantId, noGRN);
  await db.collection('goods_receipts').insertOne(doc);
  return doc;
}
