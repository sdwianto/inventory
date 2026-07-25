/**
 * W2-24 — Warehouse Slotting closeout smoke (export presence only).
 * Docs freeze; no mutation behavior asserted here.
 */
import { describe, expect, it } from 'vitest';

import {
  softPutawayBinOnWarehouseIn,
} from '@/lib/api/stok-bin-allocate';
import {
  consumeStokBinSoft,
  softConsumeBinOnWarehouseOut,
} from '@/lib/api/stok-bin-consume';
import {
  detectStokBinVsLokasi,
  repairStokBinGtMismatches,
  repairStokBinMismatches,
  runStokBinDetect,
} from '@/lib/api/stok-bin-reconcile';

describe('W2-24 Warehouse Slotting closeout smoke', () => {
  it('exports Detect / Repair LT / Repair GT from stok-bin-reconcile', () => {
    expect(typeof detectStokBinVsLokasi).toBe('function');
    expect(typeof runStokBinDetect).toBe('function');
    expect(typeof repairStokBinMismatches).toBe('function');
    expect(typeof repairStokBinGtMismatches).toBe('function');
  });

  it('exports soft IN putaway from stok-bin-allocate', () => {
    expect(typeof softPutawayBinOnWarehouseIn).toBe('function');
  });

  it('exports soft OUT consume helpers from stok-bin-consume', () => {
    expect(typeof softConsumeBinOnWarehouseOut).toBe('function');
    expect(typeof consumeStokBinSoft).toBe('function');
  });
});
