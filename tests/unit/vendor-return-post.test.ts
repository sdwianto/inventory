import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('postVendorReturn', () => {
  it('klaim POSTING di-revert pada fallback non-TX jika stok gagal', () => {
    const src = readFileSync(join(process.cwd(), 'lib/api/vendor-return-post.ts'), 'utf8');
    expect(src).toMatch(/priorStatus/);
    expect(src).toMatch(/if \(!session\)/);
    expect(src).toMatch(/status: priorStatus/);
    expect(src).toMatch(/postingStartedAt: null/);
    expect(src).toMatch(/if \(stock\.error\) throw/);
  });

  // ADR-006 — ditemukan lewat E2E manual: RTV kedua utk invoice yang sama (qty tidak
  // overlap, lolos assertReturnQtyWithinMax) tetap bisa POST dan mengeluarkan stok,
  // padahal Sales pasti menolak sync CN-nya (satu invoice cuma boleh satu CN DRAFT).
  // Cek WAJIB terjadi SEBELUM applyVendorReturnStock, supaya stok tidak pernah keluar
  // untuk retur yang sync CN-nya sudah pasti gagal.
  it('cek blockingSibling (RTV lain masih PENDING) terjadi sebelum stok keluar', () => {
    const src = readFileSync(join(process.cwd(), 'lib/api/vendor-return-post.ts'), 'utf8');
    const qtyErrIdx = src.indexOf('if (qtyErr) throw new Error(qtyErr);');
    const blockingIdx = src.indexOf('blockingSibling');
    const stockCallIdx = src.indexOf('applyVendorReturnStock(\n');
    expect(qtyErrIdx).toBeGreaterThan(-1);
    expect(blockingIdx).toBeGreaterThan(-1);
    expect(stockCallIdx).toBeGreaterThan(-1);
    expect(blockingIdx).toBeGreaterThan(qtyErrIdx);
    expect(blockingIdx).toBeLessThan(stockCallIdx);
    expect(src).toMatch(/vendorDecision \|\| ''\) === 'PENDING'/);
    expect(src).toMatch(/menunggu keputusan vendor/);
  });
});
