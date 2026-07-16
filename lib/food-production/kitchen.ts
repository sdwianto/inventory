import type { Db } from 'mongodb';
import { isValidWarehouseKode, normalizeWarehouseKode, type WarehouseCode } from '@/lib/api/warehouses';

export const KITCHENS_COLLECTION = 'kitchens';

export type KitchenType = 'CENTRAL' | 'SATELLITE';

export interface KitchenDoc {
  id: string;
  tenantId: string;
  /** Short code for UI / batch prefix (unique per tenant when set). */
  kode?: string;
  nama: string;
  kitchenType: KitchenType;
  /** Satellite may link to a central kitchen hub. */
  centralKitchenId?: string;
  defaultWarehouseKode: WarehouseCode;
  pic?: string;
  aktif: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const KITCHEN_TYPE_LABELS: Record<KitchenType, string> = {
  CENTRAL: 'Central Kitchen',
  SATELLITE: 'Dapur Satelit',
};

export function normalizeKitchenWarehouse(value: unknown): WarehouseCode | null {
  const kode = normalizeWarehouseKode(String(value || ''));
  if (!isValidWarehouseKode(kode)) return null;
  return kode as WarehouseCode;
}

export function normalizeKitchenType(raw: unknown): KitchenType {
  const v = String(raw || '').toUpperCase();
  return v === 'CENTRAL' ? 'CENTRAL' : 'SATELLITE';
}

export function normalizeKitchenKode(raw: unknown): string | undefined {
  const k = String(raw || '').trim().toUpperCase().replace(/\s+/g, '-');
  return k || undefined;
}

/** Satellite must not point to itself; central must not have centralKitchenId. */
export function assertKitchenHubLink(input: {
  kitchenType: KitchenType;
  kitchenId?: string;
  centralKitchenId?: string;
}): string | null {
  if (input.kitchenType === 'CENTRAL' && input.centralKitchenId) {
    return 'Central Kitchen tidak boleh punya centralKitchenId';
  }
  if (input.centralKitchenId && input.kitchenId && input.centralKitchenId === input.kitchenId) {
    return 'Dapur tidak boleh merujuk dirinya sebagai central';
  }
  return null;
}

export async function findKitchen(
  db: Db,
  tenantId: string,
  id: string,
): Promise<KitchenDoc | null> {
  const doc = await db.collection(KITCHENS_COLLECTION).findOne({ tenantId, id });
  return doc as KitchenDoc | null;
}
