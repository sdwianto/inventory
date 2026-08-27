import { describe, expect, it } from 'vitest';
import {
  appendReleaseFormItem,
  backfillReleaseItemLabels,
  buildReleaseFormItem,
  catalogFromSaldoRows,
  patchReleaseFormItemUom,
  qtyAtLokasi,
  resolveReleaseItemDisplay,
  snapshotProductLabels,
  type ReleaseFormItem,
} from '@/lib/pengeluaran-stok/release-form-items';
import type { JsonObject } from '@/types/json';

const product: JsonObject = {
  id: 'prod-1',
  kode: 'B335256-01',
  nama: 'Bawang Merah Kupas',
  satuan: 'KG',
  stokByWarehouse: { GKERING: 88, GBASAH: 0, GJANITOR: 0 },
  stokQty: 88,
  stokTotal: 88,
};

describe('snapshotProductLabels', () => {
  it('copies primitives so later mutation of source row cannot blank labels', () => {
    const row: JsonObject = {
      ...product,
      stokByWarehouse: { ...(product.stokByWarehouse as JsonObject) },
    };
    const snap = snapshotProductLabels(row);
    row.nama = '';
    row.kode = '';
    (row.stokByWarehouse as JsonObject).GKERING = 0;
    expect(snap.nama).toBe('Bawang Merah Kupas');
    expect(snap.kode).toBe('B335256-01');
    expect(snap.stokByWarehouse.GKERING).toBe(88);
  });
});

describe('buildReleaseFormItem + append', () => {
  it('keeps nama/kode even when UOM resolves later (smoke: draft row labels)', () => {
    const pending = buildReleaseFormItem({
      product,
      lokasiKode: 'GKERING',
      uomId: '',
      clientKey: 'ck-1',
    });
    expect(pending).not.toBeNull();
    expect(pending!.nama).toBe('Bawang Merah Kupas');
    expect(pending!.kode).toBe('B335256-01');
    expect(pending!.stokAvail).toBe(88);

    const { items, duplicate } = appendReleaseFormItem([], pending!);
    expect(duplicate).toBe(false);

    const patched = patchReleaseFormItemUom(items, 'ck-1', { id: 'uom-kg', satuan: 'KG' });
    expect(patched.duplicate).toBe(false);
    expect(patched.items).toHaveLength(1);
    expect(patched.items[0].nama).toBe('Bawang Merah Kupas');
    expect(patched.items[0].kode).toBe('B335256-01');
    expect(patched.items[0].uomId).toBe('uom-kg');
    expect(patched.items[0].clientKey).toBeUndefined();
  });

  it('blocks double-click before UOM resolves', () => {
    const a = buildReleaseFormItem({
      product,
      lokasiKode: 'GKERING',
      uomId: '',
      clientKey: 'ck-a',
    })!;
    const b = buildReleaseFormItem({
      product,
      lokasiKode: 'GKERING',
      uomId: '',
      clientKey: 'ck-b',
    })!;
    const first = appendReleaseFormItem([], a);
    const second = appendReleaseFormItem(first.items, b);
    expect(second.duplicate).toBe(true);
    expect(second.items).toHaveLength(1);
  });

  it('simulates concurrent add of two different products (race smoke)', () => {
    const p2: JsonObject = {
      id: 'prod-2',
      kode: 'B999',
      nama: 'Minyak Goreng',
      satuan: 'LTR',
      stokByWarehouse: { GKERING: 10 },
    };
    const a = buildReleaseFormItem({
      product,
      lokasiKode: 'GKERING',
      uomId: 'u1',
      satuan: 'KG',
    })!;
    const b = buildReleaseFormItem({
      product: p2,
      lokasiKode: 'GKERING',
      uomId: 'u2',
      satuan: 'LTR',
    })!;

    // Resolve B first (slower A finishes later) — functional append must keep both.
    let items: ReleaseFormItem[] = [];
    items = appendReleaseFormItem(items, b).items;
    items = appendReleaseFormItem(items, a).items;

    expect(items).toHaveLength(2);
    expect(items.map((it) => it.nama).sort()).toEqual([
      'Bawang Merah Kupas',
      'Minyak Goreng',
    ]);
  });
});

describe('resolveReleaseItemDisplay', () => {
  it('falls back to catalog when form nama was blank (regression: detail hilang)', () => {
    const catalog = catalogFromSaldoRows([product]);
    const display = resolveReleaseItemDisplay(
      { stokId: 'prod-1', kode: 'B335256-01', nama: '', stokAvail: 0 },
      catalog,
      'GKERING',
    );
    expect(display.nama).toBe('Bawang Merah Kupas');
    expect(display.kode).toBe('B335256-01');
    expect(display.stokAvail).toBe(88);
  });

  it('never renders empty title — uses kode then Produk', () => {
    const display = resolveReleaseItemDisplay(
      { stokId: 'missing', kode: 'B335256-01', nama: '' },
      new Map(),
      'GKERING',
    );
    expect(display.nama).toBe('B335256-01');

    const empty = resolveReleaseItemDisplay(
      { stokId: 'x', kode: '', nama: '' },
      new Map(),
      'GKERING',
    );
    expect(empty.nama).toBe('Produk');
  });
});

describe('backfillReleaseItemLabels', () => {
  it('fills blank nama from saldo catalog after async load', () => {
    const items: ReleaseFormItem[] = [
      {
        stokId: 'prod-1',
        kode: 'B335256-01',
        nama: '',
        uomId: 'u1',
        satuan: 'KG',
        qty: 1,
        stokAvail: 0,
        stokByWarehouse: {},
      },
    ];
    const result = backfillReleaseItemLabels(items, catalogFromSaldoRows([product]));
    expect(result.changed).toBe(true);
    expect(result.items[0].nama).toBe('Bawang Merah Kupas');
  });
});

describe('qtyAtLokasi', () => {
  it('reads warehouse bucket', () => {
    expect(qtyAtLokasi(product, 'GKERING')).toBe(88);
    expect(qtyAtLokasi(product, 'GBASAH')).toBe(0);
  });
});
