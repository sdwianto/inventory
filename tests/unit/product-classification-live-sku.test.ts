import { describe, expect, it } from 'vitest';
import { classifyProduct } from '@/lib/api/product-classification';

/** SKU produksi yang harus benar sebelum redeploy filter gudang. */
const LIVE_EXPECT: Array<{
  kode: string;
  grup: string;
  nama: string;
  gudangKode: 'GKERING' | 'GBASAH' | 'GJANITOR';
  itemRole: string;
}> = [
  { kode: 'B227962', grup: 'Toiletries', nama: 'Sunlight 610g', gudangKode: 'GJANITOR', itemRole: 'CONSUMABLE' },
  { kode: 'B354976', grup: 'Toiletries', nama: 'Sunlight 650g', gudangKode: 'GJANITOR', itemRole: 'CONSUMABLE' },
  { kode: 'B212248', grup: 'Palen', nama: 'Vixal 720g', gudangKode: 'GJANITOR', itemRole: 'CONSUMABLE' },
  { kode: 'B189497', grup: 'Palen', nama: 'Wipol 720g', gudangKode: 'GJANITOR', itemRole: 'CONSUMABLE' },
  { kode: 'B812467', grup: 'Umum', nama: 'Tisu Toilet GreenSoft', gudangKode: 'GJANITOR', itemRole: 'CONSUMABLE' },
  { kode: 'B582948', grup: 'Palen', nama: 'Alumunium Foil Persegi', gudangKode: 'GKERING', itemRole: 'PACKAGING' },
  { kode: 'B598280', grup: 'Palen', nama: 'Sarung Tangan Plastik Eco', gudangKode: 'GKERING', itemRole: 'PACKAGING' },
  { kode: 'B133345', grup: 'Palen', nama: 'Tisu Jolly Pop up', gudangKode: 'GKERING', itemRole: 'PACKAGING' },
  { kode: 'B361094', grup: 'Palen', nama: 'Wrapping 20cm', gudangKode: 'GKERING', itemRole: 'PACKAGING' },
  { kode: 'B553057', grup: 'Bumbu', nama: 'Abon Ayam 1kg', gudangKode: 'GKERING', itemRole: 'INGREDIENT' },
  { kode: 'B915390', grup: 'Buah', nama: 'Alpukat 1kg isi 6', gudangKode: 'GBASAH', itemRole: 'INGREDIENT' },
  { kode: 'B247787', grup: 'Sayuran', nama: 'Selada', gudangKode: 'GBASAH', itemRole: 'INGREDIENT' },
  { kode: 'B968377', grup: 'Hewani', nama: 'Telur Ayam Horn', gudangKode: 'GBASAH', itemRole: 'INGREDIENT' },
  { kode: 'B511393', grup: 'Bumbu', nama: 'Desaku Marinasi Instan 12,5g', gudangKode: 'GKERING', itemRole: 'INGREDIENT' },
];

describe('live SKU classification gate', () => {
  it('places janitor, packaging, wet, and dry SKUs correctly', () => {
    for (const row of LIVE_EXPECT) {
      expect(classifyProduct({ grup: row.grup, nama: row.nama }), `${row.kode} ${row.nama}`).toEqual({
        itemRole: row.itemRole,
        gudangKode: row.gudangKode,
      });
    }
  });
});
