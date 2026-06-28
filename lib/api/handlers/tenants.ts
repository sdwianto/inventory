import type { Db } from 'mongodb';
// Tenants & tenant settings handler (MASTER-tier resource).

import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import { sanitizeStoreSettings } from '@/lib/receipt-doc';
import { requireAuth, requireMaster, requireTenantAccess } from '@/lib/api/require-auth';
import { bootstrapTenantMasterData } from '@/lib/api/tenant-master';
import { purgeTenantData } from '@/lib/api/purge-tenant';
import { ACTING_TENANT_COOKIE, sessionCookieOptions } from '@/lib/api/session';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import type { HandlerContext } from '@/types/api/handler';
import type { AuthContext } from '@/types/auth';

interface TenantSettingsDoc extends Record<string, unknown> {
  tenantId: string;
  companyName?: string;
  companyAddress?: string;
  companyPhone?: string;
  companyNPWP?: string;
  logoBase64?: string;
  updatedAt?: Date;
}

interface TenantCreateBody {
  tenantId?: string;
  tenantName?: string;
  companyAddress?: string;
  companyPhone?: string;
  companyNPWP?: string;
  logoBase64?: string;
  seedDemoProducts?: boolean;
}

interface TenantSettingsBody extends Record<string, unknown> {
  tenantId?: string;
  logoBase64?: string;
}

function effectiveTenantId(auth: AuthContext, requested: string | null | undefined): string {
  if (auth.isMaster) return (requested || auth.tenantId || 'default').trim();
  return auth.tenantId || 'default';
}

export async function handleTenants({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
}: HandlerContext): Promise<NextResponse | null> {
  if (route === '/tenant/acting' && method === 'POST') {
    const denied = requireMaster(auth);
    if (denied) return denied;
    const actingBody = (body || {}) as { tenantId?: string };
    const tenantId = normalizeTenantId(actingBody.tenantId || '');
    if (!tenantId || tenantId === 'master') {
      return err('tenantId operasional wajib (bukan "master")', 400);
    }
    const settings = await db.collection<TenantSettingsDoc>('tenant_settings').findOne({ tenantId });
    if (!settings) return err(`Tenant "${tenantId}" tidak ditemukan`, 404);
    const res = ok({
      tenantId,
      tenantName: settings.companyName || tenantId,
    });
    res.cookies.set(ACTING_TENANT_COOKIE, tenantId, sessionCookieOptions(60 * 60 * 24 * 30));
    return res;
  }

  if (route === '/tenant/acting' && method === 'DELETE') {
    const denied = requireMaster(auth);
    if (denied) return denied;
    const res = ok({ cleared: true });
    res.cookies.set(ACTING_TENANT_COOKIE, '', { ...sessionCookieOptions(0), maxAge: 0 });
    return res;
  }

  if (route === '/tenant/settings' && method === 'GET') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const userAuth = auth!;

    const requested = url.searchParams.get('tenantId');
    const tenantId = effectiveTenantId(userAuth, requested);
    const accessDenied = requireTenantAccess(userAuth, tenantId);
    if (accessDenied) return accessDenied;

    let settings = await db.collection('tenant_settings').findOne({ tenantId }) as TenantSettingsDoc | null;
    if (!settings) {
      const newSettings: TenantSettingsDoc = {
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
      await db.collection('tenant_settings').insertOne(newSettings);
      settings = newSettings;
    }
    const doc = clean(settings) as Record<string, unknown>;
    return ok({ ...doc, ...sanitizeStoreSettings(doc) });
  }

  if (route === '/tenant/settings' && method === 'PUT') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const userAuth = auth!;

    const settingsBody = (body || {}) as TenantSettingsBody;
    const tenantId = effectiveTenantId(userAuth, settingsBody.tenantId);
    const accessDenied = requireTenantAccess(userAuth, tenantId);
    if (accessDenied) return accessDenied;

    const update: Record<string, unknown> = { ...settingsBody, tenantId, updatedAt: new Date() };
    delete update.id;
    delete update._id;
    if (update.logoBase64 && String(update.logoBase64).length > 700000) {
      return err('Logo terlalu besar (max 500KB). Coba kompres dulu.', 400);
    }
    await db.collection('tenant_settings').updateOne({ tenantId }, { $set: update }, { upsert: true });
    const doc = await db.collection<TenantSettingsDoc>('tenant_settings').findOne({ tenantId });
    return ok(clean(doc));
  }

  if (route === '/tenants' && method === 'GET') {
    const denied = requireMaster(auth);
    if (denied) return denied;

    const [allSettings, users] = await Promise.all([
      db.collection<TenantSettingsDoc>('tenant_settings').find({}).toArray(),
      db.collection<{ tenantId?: string; tenantName?: string }>('users').find({}).toArray(),
    ]);
    const tenantMap: Record<string, {
      tenantId: string;
      tenantName: string;
      companyName: string;
      companyAddress: string;
      companyPhone: string;
      companyNPWP: string;
      logoBase64: string;
      userCount: number;
      updatedAt?: Date;
    }> = {};
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

    const createBody = (body || {}) as TenantCreateBody;
    const tenantId = String(createBody.tenantId || '').trim().toLowerCase();
    if (!tenantId || !createBody.tenantName) return err('tenantId dan tenantName wajib');
    if (tenantId === 'default' || tenantId === 'master') {
      return err('Tenant ID "default" dan "master" reserved — pilih ID lain', 400);
    }
    const existing = await db.collection<TenantSettingsDoc>('tenant_settings').findOne({ tenantId });
    if (existing) {
      const usedBy = existing.companyName || tenantId;
      return err(`Tenant ID "${tenantId}" sudah dipakai oleh "${usedBy}". Gunakan ID unik (mis. puspita-buah).`, 409);
    }
    const settings: TenantSettingsDoc = {
      id: uuidv4(),
      tenantId,
      companyName: createBody.tenantName,
      companyAddress: createBody.companyAddress || '',
      companyPhone: createBody.companyPhone || '',
      companyNPWP: createBody.companyNPWP || '',
      receiptFooterText: 'Terima Kasih',
      showLogoOnReceipt: true,
      showLogoOnInvoice: true,
      logoBase64: createBody.logoBase64 || '',
      ppnPercent: 11,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection('tenant_settings').insertOne(settings);
    await bootstrapTenantMasterData(db, tenantId, {
      includeProducts: createBody.seedDemoProducts === true,
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
