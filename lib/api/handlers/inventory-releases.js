// Release inventory — pengeluaran barang operasional (creator → approver).

import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import { requireAuth, requireRole, RELEASE_CREATE_ROLES, RELEASE_APPROVE_ROLES } from '@/lib/api/require-auth';
import { tenantIdForWrite, withTenantFilter, findMasterDoc, resolveOperationalScope } from '@/lib/api/tenant-master';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { guardPosting } from '@/lib/api/period-lock';
import {
  adjustStokLokasi,
  ensureStokLokasiRow,
  getQtyStokLokasi,
  syncProductStokFromLokasi,
} from '@/lib/api/stok-lokasi';
import { isValidWarehouseKode, warehouseLabel, normalizeWarehouseKode } from '@/lib/api/warehouses';
import { assertProductWarehouse } from '@/lib/api/product-warehouse';

function genNoRelease() {
  const now = new Date();
  return `RL${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
}

async function loadRelease(db, scopeAuth, id) {
  return db.collection('inventory_releases').findOne(withTenantFilter(scopeAuth, { id }));
}

export async function handleInventoryReleases({ db, route, method, path, body, url, auth, request }) {
  // GET /inventory-releases
  if (route === '/inventory-releases' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const list = await db.collection('inventory_releases')
      .find(withTenantFilter(scopeAuth, {}))
      .sort({ tanggal: -1 })
      .limit(300)
      .toArray();
    return ok(list.map(clean));
  }

  // GET /inventory-releases/:id
  if (path[0] === 'inventory-releases' && path.length === 2 && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    return ok(clean(doc));
  }

  // POST /inventory-releases — buat draft
  if (route === '/inventory-releases' && method === 'POST') {
    const deniedRole = requireRole(auth, RELEASE_CREATE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body, request });
    if (denied) return denied;
    const items = body?.items || [];
    if (!items.length) return err('Minimal 1 item');
    if (!body?.keperluan?.trim()) return err('Keperluan operasional wajib diisi');
    const tenantId = tenantIdForWrite(scopeAuth, body);
    const lokasiKode = normalizeWarehouseKode(body.lokasiKode || body.lokasi);
    if (!isValidWarehouseKode(lokasiKode)) return err('Pilih gudang: GKERING atau GBASAH', 400);

    const lineItems = [];
    for (const it of items) {
      const prod = await findMasterDoc(db, 'products', scopeAuth, { id: it.stokId });
      if (!prod) return err(`Produk tidak ditemukan: ${it.kode || it.stokId}`, 404);
      const whErr = assertProductWarehouse(prod, lokasiKode);
      if (whErr) return err(whErr.error, 400);
      const qty = parseFloat(it.qty) || 0;
      if (qty <= 0) return err(`Qty tidak valid: ${prod.nama}`, 400);
      const avail = await getQtyStokLokasi(db, tenantId, prod.id, lokasiKode);
      if (avail < qty) {
        return err(`Stok ${prod.nama} di ${warehouseLabel(lokasiKode)} tidak cukup (sisa: ${avail})`, 400);
      }
      lineItems.push({
        stokId: prod.id,
        kode: prod.kode,
        nama: prod.nama,
        satuan: prod.satuan,
        qty,
        hargaBeli: parseInt(prod.hargaBeli || 0, 10),
      });
    }

    const now = new Date();
    const submitNow = body.submit === true;
    const doc = stampTenantId(tenantId, {
      id: uuidv4(),
      noRelease: genNoRelease(),
      status: submitNow ? 'PENDING_APPROVAL' : 'DRAFT',
      tanggal: now,
      lokasiKode,
      lokasiNama: warehouseLabel(lokasiKode),
      keperluan: String(body.keperluan).trim(),
      keterangan: body.keterangan || '',
      items: lineItems,
      createdBy: { userId: auth.userId, userName: auth.name || auth.email, role: auth.role },
      submittedAt: submitNow ? now : null,
      createdAt: now,
    });
    await db.collection('inventory_releases').insertOne(doc);
    return ok(clean(doc));
  }

  // POST /inventory-releases/:id/submit
  if (path[0] === 'inventory-releases' && path[2] === 'submit' && method === 'POST') {
    const deniedRole = requireRole(auth, RELEASE_CREATE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body, request });
    if (denied) return denied;
    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    if (doc.status !== 'DRAFT') return err('Hanya draft yang bisa diajukan', 400);
    if (doc.createdBy?.userId !== auth.userId && !auth.isMaster && auth.role !== 'ADMIN') {
      return err('Hanya pembuat yang bisa mengajukan', 403);
    }
    const now = new Date();
    await db.collection('inventory_releases').updateOne(
      { id: doc.id },
      { $set: { status: 'PENDING_APPROVAL', submittedAt: now } },
    );
    return ok(clean(await loadRelease(db, scopeAuth, doc.id)));
  }

  // POST /inventory-releases/:id/approve — approver release stok
  if (path[0] === 'inventory-releases' && path[2] === 'approve' && method === 'POST') {
    const deniedRole = requireRole(auth, RELEASE_APPROVE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body, request });
    if (denied) return denied;
    const locked = await guardPosting(db, scopeAuth, body);
    if (locked) return locked;

    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    if (doc.status !== 'PENDING_APPROVAL') return err('Status harus PENDING_APPROVAL', 400);
    if (doc.createdBy?.userId === auth.userId && !auth.isMaster && auth.role !== 'ADMIN') {
      return err('Tidak bisa menyetujui permintaan sendiri', 403);
    }

    const tenantId = doc.tenantId;
    const lokasiKode = doc.lokasiKode;
    const now = new Date();

    for (const it of doc.items || []) {
      await ensureStokLokasiRow(db, tenantId, it.stokId, lokasiKode);
      const adj = await adjustStokLokasi(db, tenantId, it.stokId, lokasiKode, -it.qty);
      if (adj.error) return err(`${it.nama}: ${adj.error}`, 400);
      await syncProductStokFromLokasi(db, tenantId, it.stokId);
      await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
        id: uuidv4(),
        stokId: it.stokId,
        lokasi: `${lokasiKode} - ${doc.lokasiNama}`,
        tanggal: now,
        noTransaksi: doc.noRelease,
        keterangan: `Release operasional: ${doc.keperluan}`,
        sourceType: 'RELEASE',
        masuk: 0,
        keluar: it.qty,
        hargaSatuan: it.hargaBeli || 0,
      }));
    }

    await db.collection('inventory_releases').updateOne(
      { id: doc.id },
      {
        $set: {
          status: 'POSTED',
          approvedBy: { userId: auth.userId, userName: auth.name || auth.email, role: auth.role },
          approvedAt: now,
          postedAt: now,
          approveNote: body?.note || '',
        },
      },
    );
    return ok(clean(await loadRelease(db, scopeAuth, doc.id)));
  }

  // POST /inventory-releases/:id/reject
  if (path[0] === 'inventory-releases' && path[2] === 'reject' && method === 'POST') {
    const deniedRole = requireRole(auth, RELEASE_APPROVE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body, request });
    if (denied) return denied;
    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    if (doc.status !== 'PENDING_APPROVAL') return err('Status harus PENDING_APPROVAL', 400);
    const now = new Date();
    await db.collection('inventory_releases').updateOne(
      { id: doc.id },
      {
        $set: {
          status: 'REJECTED',
          rejectedBy: { userId: auth.userId, userName: auth.name || auth.email },
          rejectedAt: now,
          rejectReason: body?.reason || 'Ditolak',
        },
      },
    );
    return ok(clean(await loadRelease(db, scopeAuth, doc.id)));
  }

  // DELETE /inventory-releases/:id — batalkan draft
  if (path[0] === 'inventory-releases' && path.length === 2 && method === 'DELETE') {
    const deniedRole = requireRole(auth, RELEASE_CREATE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body, request });
    if (denied) return denied;
    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    if (doc.status !== 'DRAFT') return err('Hanya draft yang bisa dibatalkan', 400);
    await db.collection('inventory_releases').updateOne(
      { id: doc.id },
      { $set: { status: 'CANCELLED', cancelledAt: new Date() } },
    );
    return ok({ message: 'cancelled' });
  }

  return null;
}
