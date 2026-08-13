import { describe, expect, it } from 'vitest';

/**
 * Mirror of enrich mapping for GRN date columns — keeps UI contract stable.
 * tanggalPermintaanKirim ← PO.tanggalKedatangan; tanggalAktualKirim ← shippedAt/tanggal.
 */
function resolveGrnDisplayDates(grn: {
  tanggalPermintaanKirim?: Date | string | null;
  tanggalAktualKirim?: Date | string | null;
  shippedAt?: Date | string | null;
  tanggal?: Date | string | null;
  noPO?: string | null;
}, poDates: Record<string, Date>) {
  const noPO = String(grn.noPO || '').trim();
  const tanggalPermintaanKirim = grn.tanggalPermintaanKirim
    || (noPO ? poDates[noPO] : undefined)
    || null;
  const tanggalAktualKirim = grn.tanggalAktualKirim || grn.shippedAt || grn.tanggal || null;
  return { tanggalPermintaanKirim, tanggalAktualKirim };
}

describe('GRN dual date columns', () => {
  it('prefers PO tanggalKedatangan for permintaan kirim', () => {
    const poDate = new Date('2026-08-12T00:00:00+07:00');
    const r = resolveGrnDisplayDates(
      { noPO: 'CPO2608000001', tanggal: new Date('2026-08-13T09:50:00+07:00') },
      { CPO2608000001: poDate },
    );
    expect(r.tanggalPermintaanKirim).toEqual(poDate);
    expect(r.tanggalAktualKirim).toEqual(new Date('2026-08-13T09:50:00+07:00'));
  });

  it('keeps snapshot tanggalPermintaanKirim over PO lookup', () => {
    const snap = new Date('2026-08-11T00:00:00+07:00');
    const r = resolveGrnDisplayDates(
      {
        noPO: 'CPO1',
        tanggalPermintaanKirim: snap,
        shippedAt: new Date('2026-08-13T10:00:00Z'),
      },
      { CPO1: new Date('2026-08-99') },
    );
    expect(r.tanggalPermintaanKirim).toEqual(snap);
  });

  it('falls back aktual kirim: tanggalAktualKirim → shippedAt → tanggal', () => {
    expect(resolveGrnDisplayDates({ tanggal: '2026-08-13' }, {}).tanggalAktualKirim).toBe('2026-08-13');
    expect(resolveGrnDisplayDates({ shippedAt: 'a', tanggal: 'b' }, {}).tanggalAktualKirim).toBe('a');
  });
});
