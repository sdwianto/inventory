import { describe, expect, it } from 'vitest';
import {
  buildItemAvailability,
  buildPoAvailabilityView,
  vendorAvailabilityKey,
  type VendorAvailabilityLine,
} from '@/lib/pembelian-po/vendor-availability-view';
import { mapAvailabilityLines, availabilityVendorTargets } from '@/lib/api/cpo-vendor-availability';
import {
  arrivalRiskHash,
  buildArrivalRiskMessage,
  collectArrivalRisk,
  wibDateKey,
} from '@/lib/api/po-arrival-risk';

const line = (p: Partial<VendorAvailabilityLine>): VendorAvailabilityLine => ({
  qtyOrdered: 10,
  qtyTerkirim: 0,
  qtySiap: 0,
  reserved: false,
  qtyDiadakan: 0,
  etaDiadakan: null,
  menungguPersetujuan: false,
  qtyBelum: 0,
  qtyDibatalkan: 0,
  ...p,
});

describe('buildItemAvailability', () => {
  it('status dominan: belum > diadakan > siap', () => {
    expect(buildItemAvailability({ lineId: 'a', qty: 10 }, line({ qtySiap: 10 }), null).status).toBe('SIAP');
    expect(buildItemAvailability({ lineId: 'a', qty: 10 }, line({ qtySiap: 6, qtyDiadakan: 4 }), null).status)
      .toBe('DIADAKAN');
    expect(buildItemAvailability({ lineId: 'a', qty: 10 }, line({ qtySiap: 6, qtyBelum: 4 }), null).status)
      .toBe('BELUM');
  });

  it('kiriman lokal lebih baru memotong porsi siap dulu', () => {
    const v = buildItemAvailability(
      { lineId: 'a', qty: 10, qtyShipped: 6 },
      line({ qtySiap: 6, qtyDiadakan: 4 }),
      null,
    );
    expect(v.qtyTerkirim).toBe(6);
    expect(v.qtySiap).toBe(0);
    expect(v.qtyDiadakan).toBe(4);
    expect(v.status).toBe('DIADAKAN');
  });

  it('terkirim penuh dan dibatalkan', () => {
    expect(buildItemAvailability({ lineId: 'a', qty: 5, qtyReceived: 5 }, null, null).status).toBe('TERKIRIM');
    expect(buildItemAvailability({ lineId: 'a', qty: 5, cancelled: true }, null, null).status).toBe('DIBATALKAN');
    expect(buildItemAvailability({ lineId: 'a', qty: 5 }, null, null)).toMatchObject({
      status: 'TIDAK_DIKETAHUI',
      source: 'NONE',
    });
  });

  it('ETA lewat kedatangan ditandai', () => {
    const v = buildItemAvailability(
      { lineId: 'a', qty: 10 },
      line({ qtyDiadakan: 10, etaDiadakan: '2026-10-03T00:00:00.000Z' }),
      '2026-10-02',
    );
    expect(v.etaLewatKedatangan).toBe(true);
  });
});

describe('buildPoAvailabilityView', () => {
  const now = new Date('2026-10-01T02:00:00.000Z');
  it('status belum dikirim ke vendor → tidak berlaku', () => {
    expect(buildPoAvailabilityView({ status: 'APPROVED', items: [] }, now).applicable).toBe(false);
  });

  it('REMOTE: ringkasan + stale berdasar fetchedAt', () => {
    const view = buildPoAvailabilityView({
      status: 'CONFIRMED',
      tanggalKedatangan: new Date('2026-10-02T12:00:00.000Z'),
      items: [{ lineId: 'l1', qty: 10 }, { lineId: 'l2', qty: 4 }],
      vendorAvailability: {
        fetchedAt: new Date(now.getTime() - 60_000),
        vendors: {
          v1: {
            vendorTenantId: 'v1',
            state: 'OK',
            lines: { l1: line({ qtyBelum: 10 }), l2: line({ qtyOrdered: 4, qtySiap: 4 }) },
          },
        },
      },
    }, now);
    expect(view.mode).toBe('REMOTE');
    expect(view.stale).toBe(false);
    expect(view.summary).toMatchObject({ total: 2, belum: 1, siap: 1 });
  });

  it('LOCAL untuk PO yang sudah dikirim — tanpa data vendor', () => {
    const view = buildPoAvailabilityView({
      status: 'SHIPPED',
      items: [{ lineId: 'l1', qty: 3, qtyShipped: 3 }],
      vendorAvailability: { vendors: { v1: { vendorTenantId: 'v1', state: 'OK', lines: { l1: line({ qtyBelum: 3 }) } } } },
    }, now);
    expect(view.mode).toBe('LOCAL');
    expect(view.items[0].status).toBe('TERKIRIM');
  });
});

describe('mapAvailabilityLines', () => {
  const po = {
    vendorTenantId: 'multi',
    items: [
      { lineId: 'l1', vendorStokId: 's1', vendorTenantId: 'v1' },
      { lineId: 'l2', vendorStokId: 's2', vendorTenantId: 'v1' },
      { lineId: 'l3', vendorStokId: 's2', vendorTenantId: 'v1' },
      { lineId: 'l4', vendorStokId: 's9', vendorTenantId: 'v2' },
    ],
  };

  it('utamakan customerPoLineId; fallback stokId hanya bila unik', () => {
    const out = mapAvailabilityLines(po, 'v1', [
      { customerPoLineId: 'l2', stokId: 's2', qtySiap: 1 },
      { stokId: 's1', qtyBelum: 2 },
      { stokId: 's2', qtyBelum: 3 },
      { stokId: 's9', qtyBelum: 4 },
    ]);
    expect(Object.keys(out).sort()).toEqual(['l1', 'l2']);
    expect(out.l1.qtyBelum).toBe(2);
    expect(out.l2.qtySiap).toBe(1);
  });

  it('baris SO terpecah untuk satu baris PO dijumlahkan; ETA terakhir, reserved hanya bila semua porsi siap direservasi', () => {
    const out = mapAvailabilityLines(po, 'v1', [
      { customerPoLineId: 'l1', qtyOrdered: 6, qtySiap: 6, reserved: true },
      { customerPoLineId: 'l1', qtyOrdered: 4, qtyDiadakan: 4, etaDiadakan: '2026-10-09', menungguPersetujuan: true },
    ]);
    expect(out.l1).toMatchObject({
      qtyOrdered: 10, qtySiap: 6, qtyDiadakan: 4, etaDiadakan: '2026-10-09', reserved: true, menungguPersetujuan: true,
    });
  });

  it('satuan SO beda dari satuan PO → qty diskalakan ke satuan PO; fallback stokId ditolak bila satuan beda', () => {
    const poUnits = {
      vendorTenantId: 'v1',
      items: [
        { lineId: 'l1', vendorStokId: 's1', qty: 2, satuan: 'DUS' },
        { lineId: 'l2', vendorStokId: 's2', qty: 5, satuan: 'KG' },
      ],
    };
    const out = mapAvailabilityLines(poUnits, 'v1', [
      { customerPoLineId: 'l1', satuan: 'PCS', qtyOrdered: 24, qtySiap: 12, qtyBelum: 12 },
      { stokId: 's2', satuan: 'GRAM', qtyOrdered: 5000, qtySiap: 5000 },
    ]);
    expect(out.l1).toMatchObject({ qtyOrdered: 2, qtySiap: 1, qtyBelum: 1 });
    expect(out.l2).toBeUndefined();
  });

  it('ETA dari sales disimpan sebagai kunci hari WIB', () => {
    const out = mapAvailabilityLines(po, 'v1', [
      { customerPoLineId: 'l1', qtyDiadakan: 1, etaDiadakan: '2026-10-09T18:00:00.000Z' },
    ]);
    expect(out.l1.etaDiadakan).toBe('2026-10-10');
  });

  it('target vendor dari vendorSubmissions, abaikan FAILED/CANCELLED', () => {
    expect(availabilityVendorTargets({
      vendorSubmissions: [
        { vendorTenantId: 'v1', status: 'SYNCED' },
        { vendorTenantId: 'v2', status: 'FAILED' },
        { vendorTenantId: 'v3', status: 'CANCELLED' },
      ],
    })).toEqual(['v1']);
    expect(availabilityVendorTargets({ vendorTenantId: 'v9' })).toEqual(['v9']);
  });

  it('kunci path Mongo aman', () => {
    expect(vendorAvailabilityKey('a.b$c')).toBe('a_b_c');
  });
});

describe('po-arrival-risk', () => {
  it('tanggal WIB', () => {
    expect(wibDateKey(new Date('2026-10-01T18:00:00.000Z'))).toBe('2026-10-02');
  });

  it('pesan + hash stabil terhadap urutan', () => {
    const po = { items: [{ lineId: 'l1', nama: 'Telur', satuan: 'KG' }, { lineId: 'l2', nama: 'Salak', satuan: 'KG' }] };
    const items = buildPoAvailabilityView({
      status: 'CONFIRMED',
      tanggalKedatangan: '2026-10-02',
      items: [{ lineId: 'l1', qty: 10 }, { lineId: 'l2', qty: 5 }],
      vendorAvailability: {
        fetchedAt: new Date(),
        vendors: {
          v1: {
            vendorTenantId: 'v1',
            state: 'OK',
            lines: {
              l1: line({ qtyBelum: 10 }),
              l2: line({ qtyOrdered: 5, qtyDiadakan: 5, etaDiadakan: '2026-10-04T00:00:00.000Z' }),
            },
          },
        },
      },
    }).items;
    const risk = collectArrivalRisk(po, items);
    expect(risk.map((r) => r.kind)).toEqual(['BELUM', 'ETA_LEWAT']);
    expect(arrivalRiskHash(risk)).toBe(arrivalRiskHash([...risk].reverse()));
    const msg = buildArrivalRiskMessage('CPO-1', '2026-10-02', risk);
    expect(msg.body).toContain('Telur (10 KG)');
    expect(msg.body).toContain('ETA 4 Okt 2026');
  });

  it('item tanpa info vendor ikut diperingatkan bila diminta', () => {
    const po = { items: [{ lineId: 'l1', nama: 'Telur', satuan: 'KG' }] };
    const items = buildPoAvailabilityView({
      status: 'CONFIRMED',
      items: [{ lineId: 'l1', qty: 10, qtyShipped: 3 }],
      vendorAvailability: { fetchedAt: new Date(), vendors: { v1: { vendorTenantId: 'v1', state: 'NO_SO', lines: {} } } },
    }).items;
    expect(collectArrivalRisk(po, items)).toEqual([]);
    const risk = collectArrivalRisk(po, items, { includeUnknown: true });
    expect(risk).toMatchObject([{ kind: 'TIDAK_DIKETAHUI', qty: 7 }]);
    expect(buildArrivalRiskMessage('CPO-1', '2026-10-02', risk).body).toContain('belum ada info ketersediaan');
  });
});

describe('formatTelegramMessage', () => {
  it('escape kutip & dipotong sebelum escape (tag tetap utuh, ≤ 4000)', async () => {
    const { formatTelegramMessage } = await import('@/lib/notifications/telegram');
    const short = formatTelegramMessage({ title: 'A "B" <c>', body: 'x & y' });
    expect(short).toBe('<b>A &quot;B&quot; &lt;c&gt;</b>\n\nx &amp; y');
    const long = formatTelegramMessage({ title: 'T', body: '&'.repeat(5000) });
    expect(long.length).toBeLessThanOrEqual(4000);
    expect(long.startsWith('<b>T</b>')).toBe(true);
    expect(long.endsWith('&amp;…')).toBe(true);
  });
});
