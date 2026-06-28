import {
  PO_CHANNEL_LOCAL,
  PO_CHANNEL_VENDOR,
  type PoChannel,
} from '@/types/purchase-order';

export const LOCAL_PO_COLLECTION = 'local_purchase_orders';
export const VENDOR_PO_COLLECTION = 'customer_purchase_orders';

/** Feature flag — aktifkan saat UI + alur GRN/hutang manual siap. */
export const LOCAL_PO_MODULE_ENABLED = false;

export function normalizePoChannel(value: unknown): PoChannel {
  return value === PO_CHANNEL_LOCAL ? PO_CHANNEL_LOCAL : PO_CHANNEL_VENDOR;
}

export function isVendorPo(doc: { poChannel?: unknown } | null | undefined): boolean {
  return normalizePoChannel(doc?.poChannel) === PO_CHANNEL_VENDOR;
}

export function isLocalPo(doc: { poChannel?: unknown } | null | undefined): boolean {
  return normalizePoChannel(doc?.poChannel) === PO_CHANNEL_LOCAL;
}

export function vendorPoWriteFields(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { poChannel: PO_CHANNEL_VENDOR, ...extra };
}
