// Tenants & tenant settings handler (MASTER-tier resource).

import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import { sanitizeStoreSettings } from '@/lib/receipt-doc';
import { requireMaster, requireTenantAccess } from '@/lib/api/require-auth';
import { bootstrapTenantMasterData } from '@/lib/api/tenant-master';
import { purgeTenantData } from '@/lib/api/purge-tenant';

function effectiveTenantId(auth, requested) {
  if (auth.isMaster) return (requested || auth.tenantId || 'default').trim();
  return auth.tenantId || 'default';
}

export async function handleTenants({ db, route, method, path, body, url, auth }) {
  // ---------- TENANT SETTINGS ----------
  if (route === '/tenant/settings' && method === 'GET') {
    const requested = url.searchParams.get('tenantId');
    const tenantId = effectiveTenantId(auth, requested);
    const denied = requireTenantAccess(auth, tenantId);
    if (denied) return denied;

    let settings = await db.collection('tenant_settings').findOne({ tenantId });
    if (!settings) {
      settings = {
        id: uuidv4(),
        tenantId,
        companyName: tenantId === 'master' ? 'Pusat Master' : tenantId,
        companyAddress: '',
        companyPhone: '',
        companyNPWP: '',
        receiptFooterText: 'Terima Kasih',
        showLogoOnReceipt: true,
        showLogoOnInvoice: true,
        logoBase64: '',
        ppnPercent: 11,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await db.collection('tenant_settings').insertOne(settings);
    }
    const doc = clean(settings);
    return ok({ ...doc, ...sanitizeStoreSettings(doc) });
  }

  if (route === '/tenant/settings' && method === 'PUT') {
    const tenantId = effectiveTenantId(auth, body?.tenantId);
    const denied = requireTenantAccess(auth, tenantId);
    if (denied) return denied;

    const update = { ...(body || {}), tenantId, updatedAt: new Date() };
    delete update.id;
    delete update._id;
    if (update.logoBase64 && update.logoBase64.length > 700000) {
      return err('Logo terlalu besar (max 500KB). Coba kompres dulu.', 400);
    }
    await db.collection('tenant_settings').updateOne({ tenantId }, { $set: update }, { upsert: true });
    const doc = await db.collection('tenant_settings').findOne({ tenantId });
    return ok(clean(doc));
  }

  // ---------- TENANTS LIST (MASTER) ----------
  if (route === '/tenants' && method === 'GET') {
    const denied = requireMaster(auth);
    if (denied) return denied;

    const [allSettings, users] = await Promise.all([
      db.collection('tenant_settings').find({}).toArray(),
      db.collection('users').find({}).toArray(),
    ]);
    const tenantMap = {};
    for (const s of allSettings) {
      tenantMap[s.tenantId] = {
        tenantId: s.tenantId,
        tenantName: s.companyName || s.tenantId,
        companyName: s.companyName || '-',
        companyAddress: s.companyAddress || '',
        companyPhone: s.companyPhone || '',
        companyNPWP: s.companyNPWP || '',
        logoBase64: s.logoBase64 || '',
        userCount: 0,
        updatedAt: s.updatedAt,
      };
    }
    for (const u of users) {
      const tid = u.tenantId || 'default';
      if (!tenantMap[tid]) {
        tenantMap[tid] = {
          tenantId: tid,
          tenantName: u.tenantName || tid,
          companyName: u.tenantName || tid,
          companyAddress: '',
          companyPhone: '',
          companyNPWP: '',
          logoBase64: '',
          userCount: 0,
        };
      }
      tenantMap[tid].userCount++;
    }
    const list = Object.values(tenantMap).filter((t) => t.tenantId !== 'default');
    return ok(list);
  }

  if (route === '/tenants' && method === 'POST') {
    const denied = requireMaster(auth);
    if (denied) return denied;

    const tenantId = String(body?.tenantId || '').trim().toLowerCase();
    if (!tenantId || !body?.tenantName) return err('tenantId dan tenantName wajib');
    if (tenantId === 'default' || tenantId === 'master') {
      return err('Tenant ID "default" dan "master" reserved — pilih ID lain', 400);
    }
    const existing = await db.collection('tenant_settings').findOne({ tenantId });
    if (existing) {
      const usedBy = existing.companyName || existing.tenantId;
      return err(`Tenant ID "${tenantId}" sudah dipakai oleh "${usedBy}". Gunakan ID unik (mis. puspita-buah).`, 409);
    }
    const settings = {
      id: uuidv4(),
      tenantId,
      companyName: body.tenantName,
      companyAddress: body.companyAddress || '',
      companyPhone: body.companyPhone || '',
      companyNPWP: body.companyNPWP || '',
      receiptFooterText: 'Terima Kasih',
      showLogoOnReceipt: true,
      showLogoOnInvoice: true,
      logoBase64: body.logoBase64 || '',
      ppnPercent: 11,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection('tenant_settings').insertOne(settings);
    await bootstrapTenantMasterData(db, tenantId, {
      includeProducts: body.seedDemoProducts === true,
    });
    return ok(clean(settings));
  }

  if (path[0] === 'tenants' && path.length === 2 && method === 'DELETE') {
    const denied = requireMaster(auth);
    if (denied) return denied;

    const tenantId = path[1];
    if (tenantId === 'master') {
      return err('Tenant master tidak bisa dihapus', 400);
    }
    const userCount = await db.collection('users').countDocuments({ tenantId });
    const force = url.searchParams.get('force') === 'true';
    if (userCount > 0 && !force) {
      return err(`Tenant masih punya ${userCount} user. Tambahkan ?force=true untuk hapus paksa (users juga akan dihapus).`, 400);
    }
    const purge = await purgeTenantData(db, tenantId, { deleteUsers: force || userCount === 0 });
    return ok({
      message: 'deleted',
      tenantId,
      usersDeleted: purge.counts?.users ?? 0,
      counts: purge.counts,
    });
  }

  return null;
}
