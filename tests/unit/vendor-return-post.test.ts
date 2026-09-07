import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('postVendorReturn', () => {
  it('klaim POSTING hanya dari PENDING_APPROVAL (SoD)', () => {
    const src = readFileSync(join(process.cwd(), 'lib/api/vendor-return-post.ts'), 'utf8');
    expect(src).toMatch(/status: 'PENDING_APPROVAL'/);
    expect(src).toMatch(/harus berstatus PENDING_APPROVAL/);
  });

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
    const blockingIdx = src.indexOf('const blockingSibling = findInflightVendorReturnSibling');
    const stockCallIdx = src.indexOf('await applyVendorReturnStock(');
    expect(qtyErrIdx).toBeGreaterThan(-1);
    expect(blockingIdx).toBeGreaterThan(-1);
    expect(stockCallIdx).toBeGreaterThan(-1);
    expect(blockingIdx).toBeGreaterThan(qtyErrIdx);
    expect(blockingIdx).toBeLessThan(stockCallIdx);
    expect(src).toMatch(/stockAppliedAt/);
    expect(src).toMatch(/SYNCING|FAILED/);
    expect(src).toMatch(/menunggu keputusan vendor|menunggu approval|sync credit note/);
  });

  it('skip applyVendorReturnStock bila stockAppliedAt sudah terisi', () => {
    const src = readFileSync(join(process.cwd(), 'lib/api/vendor-return-post.ts'), 'utf8');
    expect(src).toMatch(/Boolean\(doc\.stockAppliedAt\)/);
    expect(src).toMatch(/stockApplied\s*\?\s*\{ items: doc\.items/);
  });

  it('post RTV paired: jurnal RTV_TRANSIT_OUT sebelum POSTED', () => {
    const src = readFileSync(join(process.cwd(), 'lib/api/vendor-return-post.ts'), 'utf8');
    expect(src).toMatch(/RTV_TRANSIT_OUT/);
    expect(src).toMatch(/buildVendorReturnTransitOutJournalLines/);
    expect(src).toMatch(/canSyncCn && !isGrnReject/);
    const transitIdx = src.indexOf('RTV_TRANSIT_OUT');
    const postedIdx = src.indexOf("status: 'POSTED'");
    expect(transitIdx).toBeGreaterThan(-1);
    expect(postedIdx).toBeGreaterThan(-1);
    expect(transitIdx).toBeLessThan(postedIdx);
  });
});
