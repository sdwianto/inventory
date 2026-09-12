import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { vendorProductSnapshot } from '@/lib/api/product-sync';
import { normalizeDetailProduk, MAX_PRODUCT_FOTOS } from '@/lib/api/product-media';

describe('inventory product detailProduk + fotos', () => {
  it('VENDOR_LOCKED_FIELDS does not include detailProduk/fotos', () => {
    const src = readFileSync(join(process.cwd(), 'lib/api/handlers/products.ts'), 'utf8');
    expect(src).toMatch(/const VENDOR_LOCKED_FIELDS = \[/);
    const block = src.match(/const VENDOR_LOCKED_FIELDS = \[([\s\S]*?)\];/)?.[1] || '';
    expect(block).not.toMatch(/detailProduk/);
    expect(block).not.toMatch(/fotos/);
    expect(src).toMatch(/drainEnsureProductEnrichment/);
  });

  it('normalizeDetailProduk length guard', () => {
    expect(normalizeDetailProduk('ok')).toBe('ok');
    expect(normalizeDetailProduk('x'.repeat(4001))).toEqual(
      expect.objectContaining({ error: expect.stringMatching(/maksimal/i) }),
    );
  });

  it('vendorProductSnapshot mirrors detail + fotos when present', () => {
    const snap = vendorProductSnapshot({
      id: 'v1',
      kode: 'K1',
      nama: 'N',
      detailProduk: 'Dari Sales',
      fotos: ['https://sales.example/api/media/t/a.jpg', 'extra', '', 'b', 'c', 'd', 'e'],
    });
    expect(snap.hasDetailProduk).toBe(true);
    expect(snap.detailProduk).toBe('Dari Sales');
    expect(snap.hasFotos).toBe(true);
    expect(snap.fotos).toHaveLength(MAX_PRODUCT_FOTOS);
  });

  it('formFieldsToProductPayload includes detailProduk/fotos', () => {
    const src = readFileSync(join(process.cwd(), 'lib/uom/form.ts'), 'utf8');
    expect(src).toMatch(/detailProduk: fields\.detailProduk/);
    expect(src).toMatch(/fotos: Array\.isArray\(fields\.fotos\)/);
  });

  it('materializeInboundProductFotos keeps same-tenant media paths', async () => {
    const { materializeInboundProductFotos } = await import('@/lib/api/product-media');
    const out = await materializeInboundProductFotos('sppg', [
      '/api/media/sppg/produk-local.jpg',
      '',
    ]);
    expect(out).toEqual(['/api/media/sppg/produk-local.jpg']);
  });
});
