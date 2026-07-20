/**
 * Resolve Maintenance assets in a kitchen scope (thin join — assets.lokasi / kitchenId).
 */

import type { Db } from 'mongodb';
import { KITCHENS_COLLECTION } from '@/lib/food-production/kitchen';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Asset ids for kitchen filter; null = no kitchen filter (all). Empty array = none match. */
export async function assetIdsForKitchen(
  db: Db,
  tenantId: string,
  kitchenId?: string,
): Promise<string[] | null> {
  if (!kitchenId?.trim()) return null;
  const kid = kitchenId.trim();
  const kitchen = await db.collection(KITCHENS_COLLECTION).findOne({
    tenantId,
    id: kid,
  });
  const nama = kitchen?.nama ? String(kitchen.nama).trim() : '';
  const or: Record<string, unknown>[] = [{ kitchenId: kid }];
  if (nama) {
    or.push({ lokasi: { $regex: escapeRegex(nama), $options: 'i' } });
  }
  const assets = await db
    .collection('assets')
    .find({ tenantId, $or: or })
    .project({ id: 1 })
    .limit(500)
    .toArray();
  return assets.map((a) => String((a as { id: string }).id)).filter(Boolean);
}
