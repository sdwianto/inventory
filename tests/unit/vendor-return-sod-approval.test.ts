import { describe, expect, it } from 'vitest';
import { buildReturableLines } from '@/lib/api/vendor-return-returable';

const hutang = {
  items: [
    { lineId: 'l1', stokId: 's1', kode: 'B1', nama: 'Beras', satuan: 'KG', uomId: 'u1', qty: 10, harga: 1000 },
  ],
};

describe('RTV SoD — qty lock PENDING_APPROVAL', () => {
  it('PENDING_APPROVAL mengunci qty returable seperti POSTED', () => {
    const rows = buildReturableLines(hutang, [
      {
        id: 'r1',
        status: 'PENDING_APPROVAL',
        items: [{ invoiceLineId: 'l1', qty: 4 }],
      },
    ]);
    expect(rows[0].maxQty).toBe(6);
  });

  it('DRAFT tidak mengunci qty', () => {
    const rows = buildReturableLines(hutang, [
      {
        id: 'r1',
        status: 'DRAFT',
        items: [{ invoiceLineId: 'l1', qty: 4 }],
      },
    ]);
    expect(rows[0].maxQty).toBe(10);
  });
});

describe('stuck RTV POSTING sweep (SoD)', () => {
  it('revert stuck POSTING ke PENDING_APPROVAL bukan DRAFT', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'lib/api/stuck-posting-sweep.ts'), 'utf8');
    expect(src).toMatch(/status: 'PENDING_APPROVAL'/);
    expect(src).toMatch(/approvedAt: null/);
    // Pastikan path RTV tidak lagi hard-set ke DRAFT.
    const rtvBlock = src.slice(src.indexOf('stuckRtv'));
    expect(rtvBlock).not.toMatch(/\$set:\s*\{\s*status:\s*'DRAFT'/);
  });
});

describe('approve snapshot immutability', () => {
  it('approve tidak hydrate/mutasi items dari body', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'lib/api/handlers/vendor-returns.ts'), 'utf8');
    const approveIdx = src.indexOf("path[2] === 'post' || path[2] === 'approve'");
    const slice = src.slice(approveIdx, approveIdx + 3500);
    expect(slice).toMatch(/Approve mengunci snapshot/);
    expect(slice).not.toMatch(/hydrateDraftItems/);
    expect(slice).toMatch(/const items = doc\.items/);
  });
});
