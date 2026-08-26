// Inventory handler: Kartu Stok, Penyesuaian, Lokasi (master), Transfer Stok.
// Thin orchestrator — handlers split per Phase 3.

import type { NextResponse } from 'next/server';
import type { HandlerContext } from '@/types/api/handler';
import { handleStokSaldo } from './inventory-stok-saldo';
import { handleStokKartu } from './inventory-kartu';
import { handlePenyesuaian } from './inventory-penyesuaian';
import { handleTransfer } from './inventory-transfer';
import { handleLokasi } from './inventory-lokasi';
import { handlePanduanRelease } from './inventory-panduan-release';

export { handleStokSaldo } from './inventory-stok-saldo';
export { handleStokKartu } from './inventory-kartu';
export { handlePenyesuaian } from './inventory-penyesuaian';
export { handleTransfer } from './inventory-transfer';
export { handleLokasi } from './inventory-lokasi';
export { handlePanduanRelease } from './inventory-panduan-release';
export type { InventoryBody, ProductRow } from './inventory-shared';
export { asProductRow, itemStokId } from './inventory-shared';

export async function handleInventory(ctx: HandlerContext): Promise<NextResponse | null> {
  return (
    (await handlePanduanRelease(ctx))
    ?? (await handleStokSaldo(ctx))
    ?? (await handleStokKartu(ctx))
    ?? (await handlePenyesuaian(ctx))
    ?? (await handleTransfer(ctx))
    ?? (await handleLokasi(ctx))
    ?? null
  );
}
