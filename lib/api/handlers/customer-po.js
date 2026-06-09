// PO customer ke vendor sales.app.

import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import { requireAuth } from '@/lib/api/require-auth';
import { tenantIdForWrite, withTenantFilter } from '@/lib/api/tenant-master';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { getIntegrationConfig } from '@/lib/api/integration-config';

async function pushPoToVendor(db, body, tenantId) {
  const config = await getIntegrationConfig(db, tenantId);
  const salesUrl = config.salesAppUrl;
  const apiKey = config.salesApiKey;
  const vendorTenantId = config.vendorTenantId;
  if (!apiKey) return { error: 'Belum terhubung ke sales.app — jalankan pairing dari sales.app /integrasi' };
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;

  const res = await fetch(`${salesUrl}/api/integrations/customer-po`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      customerTenantId: tenantId,
      vendorTenantId,
      noPO: body.noPO,
      customerPoId: body.id,
      items: (body.items || []).map((it) => ({
        kode: it.vendorKode || it.kode,
        vendorStokId: it.vendorStokId,
        qty: it.qty,
      })),
      catatan: body.catatan || '',
      paymentTerms: body.paymentTerms || 'KREDIT',
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) return { error: data.error || `Sales.app ${res.status}` };
  return { vendorSo: data };
}

export async function handleCustomerPo({ db, route, method, path, body, url, auth }) {
  if (route === '/customer-purchase-orders' && method === 'GET') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const status = url.searchParams.get('status');
    let filter = status ? { status } : {};
    filter = withTenantFilter(auth, filter);
    const list = await db.collection('customer_purchase_orders')
      .find(filter)
      .sort({ tanggal: -1 })
      .limit(300)
      .toArray();
    return ok(list.map(clean));
  }

  if (route === '/customer-purchase-orders' && method === 'POST') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    if (!body?.items?.length) return err('Minimal satu item');

    const tenantId = tenantIdForWrite(auth, body);
    const now = new Date();
    const noPO = body.noPO || await nextDocNumber(db, tenantId, 'CPO', 'CPO');

    const doc = {
      id: uuidv4(),
      tenantId,
      noPO,
      tanggal: body.tanggal ? new Date(body.tanggal) : now,
      status: 'DRAFT',
      items: (body.items || []).map((it) => ({
        lineId: it.lineId || uuidv4(),
        localStokId: it.localStokId,
        vendorStokId: it.vendorStokId,
        vendorKode: it.vendorKode || it.kode,
        kode: it.kode,
        nama: it.nama,
        satuan: it.satuan,
        qty: parseFloat(it.qty) || 0,
      })),
      catatan: body.catatan || '',
      paymentTerms: body.paymentTerms || 'KREDIT',
      createdAt: now,
      updatedAt: now,
    };
    await db.collection('customer_purchase_orders').insertOne(doc);
    return ok(clean(doc));
  }

  if (path[0] === 'customer-purchase-orders' && path[2] === 'submit' && method === 'POST') {
    const denied = requireAuth(auth);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(auth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (po.status !== 'DRAFT') return err('PO sudah dikirim');
    if (!po.items?.length) return err('PO kosong');

    const pushed = await pushPoToVendor(db, po, po.tenantId);
    if (pushed.error) return err(pushed.error, 502);

    const vendorSo = pushed.vendorSo || {};
    const now = new Date();
    await db.collection('customer_purchase_orders').updateOne(
      { id: po.id },
      {
        $set: {
          status: 'SUBMITTED',
          vendorSoId: vendorSo.id,
          vendorNoSO: vendorSo.noSO,
          submittedAt: now,
          updatedAt: now,
        },
      },
    );
    const updated = await db.collection('customer_purchase_orders').findOne({ id: po.id });
    return ok(clean(updated));
  }

  return null;
}
