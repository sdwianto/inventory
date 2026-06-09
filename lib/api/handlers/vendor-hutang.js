// Hutang ke vendor (sales.app) — dari invoice.posted webhook.

import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import { requireAuth } from '@/lib/api/require-auth';
import { withTenantFilter } from '@/lib/api/tenant-master';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { guardPosting } from '@/lib/api/period-lock';

export async function handleVendorHutang({ db, route, method, path, body, url, auth }) {
  if (route === '/hutang' && method === 'GET') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const status = url.searchParams.get('status') || '';
    let filter = { referenceType: 'VENDOR_INVOICE' };
    if (status) filter.status = status;
    filter = withTenantFilter(auth, filter);
    const list = await db.collection('hutang').find(filter).sort({ jatuhTempo: 1 }).limit(500).toArray();
    const today = new Date();
    const result = list.map((h) => {
      const jt = new Date(h.jatuhTempo);
      const daysLate = Math.floor((today - jt) / 86400000);
      let aging = 'CURRENT';
      if (h.status !== 'LUNAS') {
        if (daysLate > 90) aging = '90+';
        else if (daysLate > 60) aging = '61-90';
        else if (daysLate > 30) aging = '31-60';
        else if (daysLate > 0) aging = '1-30';
      } else aging = 'LUNAS';
      return {
        ...clean(h),
        supplierName: h.supplierName || 'Vendor',
        aging,
        daysLate,
      };
    });
    return ok(result);
  }

  if (path[0] === 'hutang' && path.length === 2 && method === 'GET') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const doc = await db.collection('hutang').findOne(withTenantFilter(auth, { id: path[1] }));
    if (!doc) return err('Tidak ditemukan', 404);
    const pembayaran = await db.collection('hutang_pembayaran')
      .find({ hutangId: doc.id })
      .sort({ tanggal: -1 })
      .toArray();
    return ok({ ...clean(doc), pembayaran: pembayaran.map(clean) });
  }

  if (path[0] === 'hutang' && path[1] && path[2] === 'bayar' && method === 'POST') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const locked = await guardPosting(db, auth, body);
    if (locked) return locked;

    const amount = parseInt(body?.amount || 0, 10);
    if (amount <= 0) return err('Nominal tidak valid');

    const hutang = await db.collection('hutang').findOne(withTenantFilter(auth, { id: path[1] }));
    if (!hutang) return err('Hutang tidak ditemukan', 404);
    if (amount > hutang.sisa) return err(`Pembayaran melebihi sisa (${hutang.sisa})`);

    const tenantId = hutang.tenantId || auth?.tenantId || 'default';
    const now = new Date();
    const newTerbayar = (hutang.terbayar || 0) + amount;
    const newSisa = hutang.total - newTerbayar;
    const newStatus = newSisa <= 0 ? 'LUNAS' : 'PARTIAL';

    await db.collection('hutang').updateOne(
      { id: hutang.id },
      { $set: { terbayar: newTerbayar, sisa: newSisa, status: newStatus, updatedAt: now } },
    );
    await db.collection('hutang_pembayaran').insertOne(stampTenantId(tenantId, {
      id: uuidv4(),
      hutangId: hutang.id,
      tanggal: now,
      amount,
      metode: body.metode || 'TUNAI',
      keterangan: body.keterangan || '',
      userName: body.userName || '',
    }));

    const updated = await db.collection('hutang').findOne({ id: hutang.id });
    return ok(clean(updated));
  }

  return null;
}
