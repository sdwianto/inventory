import { describe, expect, it } from 'vitest';
import {
  buildApprovalRequestedMessage,
  buildApprovedMessage,
  buildRejectedMessage,
  excludeActor,
  formatPoDate,
  poVendorIds,
} from '@/lib/api/customer-po-notify';

const po = {
  id: 'p1',
  noPO: 'CPO2610000059',
  tanggalKedatangan: new Date('2026-10-03T17:30:00.000Z'),
  estimasiTotal: 0,
  items: [
    { vendorTenantId: 'v1' },
    { vendorTenantId: 'v2' },
    { vendorTenantId: 'v1' },
    { vendorTenantId: 'v3', cancelled: true },
  ],
};

describe('customer-po-notify', () => {
  it('tanggal kedatangan memakai zona WIB', () => {
    expect(formatPoDate(po.tanggalKedatangan)).toBe('04/10/2026');
    expect(formatPoDate(null)).toBe('-');
    expect(formatPoDate('bukan tanggal')).toBe('-');
  });

  it('vendor unik dari item aktif; fallback vendorTenantId level PO', () => {
    expect(poVendorIds(po)).toEqual(['v1', 'v2']);
    expect(poVendorIds({ vendorTenantId: 'vx', items: [] })).toEqual(['vx']);
    expect(poVendorIds({ vendorTenantId: 'multi', items: [] })).toEqual([]);
  });

  it('pesan pengajuan: tanpa total bila 0, vendor dibatasi, teks panjang dipotong', () => {
    const vendors = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const msg = buildApprovalRequestedMessage(
      { ...po, catatan: 'x'.repeat(500) },
      { userId: 'u1', userName: 'Andri' },
      vendors,
    );
    expect(msg.title).toBe('PO menunggu persetujuan: CPO2610000059');
    expect(msg.body).toContain('Vendor: A, B, C, D, E +2 lainnya');
    expect(msg.body).toContain('Jumlah item: 3');
    expect(msg.body).not.toContain('Estimasi total');
    const catatan = msg.body.split('\n').find((l) => l.startsWith('Catatan: '))!;
    expect(catatan.length).toBeLessThanOrEqual('Catatan: '.length + 200);
    expect(catatan.endsWith('…')).toBe(true);
  });

  it('pesan setujui mencerminkan status sinkron vendor', () => {
    expect(buildApprovedMessage(po, { userName: 'Admin' }, { vendorSynced: true }).body).toContain('sudah dikirim ke vendor');
    expect(buildApprovedMessage(po, { userName: 'Admin' }, { vendorSyncPending: true }).body).toContain('sedang diproses');
    expect(buildApprovedMessage(po, { userName: 'Admin' }, { vendorSynced: false, vendorSyncError: 'timeout' }).body)
      .toContain('belum berhasil');
  });

  it('pesan tolak memuat alasan, default bila kosong', () => {
    expect(buildRejectedMessage(po, { userName: 'Admin' }, 'Harga mahal').body).toContain('Alasan: Harga mahal');
    expect(buildRejectedMessage(po, null, '').body).toContain('Alasan: Ditolak admin');
  });

  it('pelaku dikecualikan dari penerima', () => {
    const list = [
      { id: 'a', name: 'A', role: 'ADMIN', telegramChatId: null },
      { id: 'b', name: 'B', role: 'ADMIN', telegramChatId: '1' },
    ];
    expect(excludeActor(list, { userId: 'a' }).map((r) => r.id)).toEqual(['b']);
    expect(excludeActor(list, null)).toHaveLength(2);
  });
});
