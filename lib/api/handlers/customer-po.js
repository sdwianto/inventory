// PO customer ke vendor sales.app.



import { v4 as uuidv4 } from 'uuid';

import { ok, err, clean } from '@/lib/api/db';

import { requireAuth } from '@/lib/api/require-auth';

import { tenantIdForWrite, withTenantFilter } from '@/lib/api/tenant-master';

import { nextDocNumber } from '@/lib/api/document-sequence';

import { getIntegrationConfig } from '@/lib/api/integration-config';

import { enrichPoItemsForVendor, groupPoItemsByVendorTenant } from '@/lib/api/customer-po-vendor';



async function pushPoGroupToVendor(db, { tenantId, config, po, vendorTenantId, items }) {

  const salesUrl = config.salesAppUrl;

  const apiKey = config.salesApiKey;

  const headers = { 'Content-Type': 'application/json' };

  if (apiKey) headers['X-Api-Key'] = apiKey;



  const res = await fetch(`${salesUrl}/api/integrations/customer-po`, {

    method: 'POST',

    headers,

    body: JSON.stringify({

      customerTenantId: tenantId,

      vendorTenantId,

      noPO: po.noPO,

      customerPoId: po.id,

      tanggalKedatangan: po.tanggalKedatangan || po.tanggal || null,

      items,

      catatan: po.catatan || '',

      paymentTerms: po.paymentTerms || 'KREDIT',

    }),

    signal: AbortSignal.timeout(15000),

  });

  const data = await res.json();

  if (!res.ok) return { error: data.error || `Sales.app ${res.status}`, vendorTenantId };

  return { vendorSo: data, vendorTenantId };

}



async function pushPoToVendor(db, body, tenantId) {

  const config = await getIntegrationConfig(db, tenantId);

  const apiKey = config.salesApiKey;

  if (!apiKey) return { error: 'Belum terhubung ke sales.app — jalankan pairing dari sales.app /integrasi' };



  const enriched = await enrichPoItemsForVendor(db, tenantId, body.items);

  if (enriched.error) return { error: enriched.error };



  const grouped = groupPoItemsByVendorTenant(enriched.items);

  if (grouped.error) return { error: grouped.error };



  const submissions = [];

  for (const { vendorTenantId, items } of grouped.groups) {

    const pushed = await pushPoGroupToVendor(db, {

      tenantId,

      config,

      po: body,

      vendorTenantId,

      items,

    });

    if (pushed.error) {

      return {

        error: `${pushed.error} (vendor: ${vendorTenantId})`,

        partialSubmissions: submissions,

      };

    }

    submissions.push({

      vendorTenantId,

      vendorSoId: pushed.vendorSo?.id,

      vendorNoSO: pushed.vendorSo?.noSO,

      itemCount: items.length,

    });

  }



  return { submissions };

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
      .sort({ tanggalKedatangan: -1, tanggal: -1 })
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
    const tanggalKedatangan = body.tanggalKedatangan
      ? new Date(body.tanggalKedatangan)
      : (body.tanggal ? new Date(body.tanggal) : now);

    const doc = {
      id: uuidv4(),
      tenantId,
      noPO,
      tanggal: now,
      tanggalKedatangan,
      status: 'DRAFT',

      items: await Promise.all((body.items || []).map(async (it) => {

        let vendorStokId = it.vendorStokId;

        let vendorKode = it.vendorKode || it.kode;

        let vendorTenantId = it.vendorTenantId;

        if (it.localStokId) {

          const prod = await db.collection('products').findOne({ tenantId, id: it.localStokId });

          if (prod) {

            vendorStokId = prod.vendorStokId || vendorStokId;

            vendorKode = prod.kode || vendorKode;

            vendorTenantId = prod.vendorTenantId || vendorTenantId;

          }

        }

        return {

          lineId: it.lineId || uuidv4(),

          localStokId: it.localStokId,

          vendorStokId,

          vendorTenantId,

          vendorKode,

          kode: it.kode || vendorKode,

          nama: it.nama,

          satuan: it.satuan,

          qty: parseFloat(it.qty) || 0,

          estimasiHarga: parseInt(it.estimasiHarga || 0, 10),

          hargaBeliReferensi: parseInt(it.hargaBeliReferensi || 0, 10),

        };

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



    const submissions = pushed.submissions || [];

    const primary = submissions[0] || {};

    const now = new Date();

    await db.collection('customer_purchase_orders').updateOne(

      { id: po.id },

      {

        $set: {

          status: 'SUBMITTED',

          vendorSubmissions: submissions,

          vendorTenantId: submissions.length === 1 ? primary.vendorTenantId : 'multi',

          vendorSoId: primary.vendorSoId,

          vendorNoSO: submissions.length === 1

            ? primary.vendorNoSO

            : submissions.map((s) => s.vendorNoSO).filter(Boolean).join(', '),

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

