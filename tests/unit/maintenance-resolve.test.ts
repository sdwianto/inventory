import { describe, expect, it } from 'vitest';
import { assertWrResolvable, buildPoCatatanFromWr } from '@/lib/api/maintenance-resolve';
import type { MaintenanceRequestDoc } from '@/types/maintenance';

const baseWr: MaintenanceRequestDoc = {
  id: 'wr-1',
  noWR: 'WR2606000001',
  status: 'APPROVED',
  judul: 'Mesin mati',
  assetKode: 'AST001',
  assetNama: 'Mixer',
  deskripsi: 'Tidak nyala',
};

describe('maintenance-resolve', () => {
  it('assertWrResolvable allows APPROVED without existing resolution', () => {
    expect(assertWrResolvable(baseWr, 'PO')).toBeNull();
  });

  it('blocks wrong status', () => {
    expect(assertWrResolvable({ ...baseWr, status: 'DRAFT' }, 'PO')).toBeTruthy();
  });

  it('blocks mixed resolution type', () => {
    expect(assertWrResolvable({ ...baseWr, resolutionType: 'PO' }, 'SERVICE')).toBeTruthy();
  });

  it('buildPoCatatanFromWr includes WR and asset', () => {
    const text = buildPoCatatanFromWr(baseWr);
    expect(text).toContain('WR2606000001');
    expect(text).toContain('AST001');
  });
});
