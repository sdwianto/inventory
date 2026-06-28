import { PO_CHANNEL_VENDOR } from '@/types/purchase-order';

/** PO aktif saat ini — selalu via sales.app vendor. */
export const PO_CHANNEL_ACTIVE = PO_CHANNEL_VENDOR;

export const PO_CAN_CREATE = ['GUDANG', 'SUPERVISOR', 'ADMIN', 'MASTER'] as const;
export const PO_CAN_REQUEST = ['GUDANG', 'SUPERVISOR', 'ADMIN', 'MASTER'] as const;
export const PO_CAN_DIRECT_SUBMIT = ['ADMIN', 'MASTER'] as const;
export const PO_CAN_APPROVE = ['ADMIN', 'MASTER'] as const;
export const AUTO_VENDOR_SYNC_MS = 45_000;
