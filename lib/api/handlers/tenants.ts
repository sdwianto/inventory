import type { Db } from 'mongodb';
// Tenants & tenant settings handler (MASTER-tier resource).

import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import { sanitizeStoreSettings } from '@/lib/receipt-doc';
import { requireAuth, requireMaster, requireRole, requireTenantAccess } from '@/lib/api/require-auth';
import { bootstrapTenantMasterData } from '@/lib/api/tenant-master';
import { purgeTenantData } from '@/lib/api/purge-tenant';
import {
  auditDangerousRouteAccess,
  requireProductionConfirmPhrase,
  TENANT_PURGE_CONFIRM_PHRASE,
} from '@/lib/api/production-guard';
import { ACTING_TENANT_COOKIE, sessionCookieOptions } from '@/lib/api/session';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import { storeBase64Image } from '@/lib/api/media-storage';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import { writeAuditLog } from '@/lib/api/audit-log';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import {
  RL_OVER_TOLERANCE_SETTING,
  normalizeRlOverIssueTolerancePct,
} from '@/lib/food-production/rl-over-issue';
import {
  PO_OVER_RECEIVE_TOLERANCE_SETTING,
  normalizePoOverReceiveTolerancePct,
} from '@/lib/api/po-receive-control';
import {
  DEFAULT_PRICE_TOLERANCE_PCT,
  DEFAULT_QTY_TOLERANCE_PCT,
  THREE_WAY_PRICE_TOLERANCE_SETTING,
  THREE_WAY_QTY_TOLERANCE_SETTING,
  normalizeThreeWayTolerancePct,
} from '@/lib/api/three-way-match';
import type { HandlerContext } from '@/types/api/handler';

const TOLERANCE_SETTINGS = [
  RL_OVER_TOLERANCE_SETTING,
  PO_OVER_RECEIVE_TOLERANCE_SETTING,
  THREE_WAY_QTY_TOLERANCE_SETTING,
  THREE_WAY_PRICE_TOLERANCE_SETTING,
] as const;
import type { AuthContext } from '@/types/auth';

interface TenantSettingsDoc extends Record<string, unknown> {
  tenantId: string;
  companyName?: string;
  companyAddress?: string;
  companyPhone?: string;
  companyNPWP?: string;
  logoBase64?: string;
  logoUrl?: string;
  logoMediaFile?: string;
  updatedAt?: Date;
}

interface TenantCreateBody {
  tenantId?: string;
  tenantName?: string;
  companyAddress?: string;
  companyPhone?: string;
  companyNPWP?: string;
  logoBase64?: string;
  logoUrl?: string;
  logoMediaFile?: string;
  seedDemoProducts?: boolean;
}

interface TenantSettingsBody extends Record<string, unknown> {
  tenantId?: string;
  logoBase64?: string;
  logoUrl?: string;
  logoMediaFile?: string;
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
    // Ubah pengaturan tenant hanya untuk ADMIN/OWNER/MASTER.
    const denied = requireRole(auth, ['ADMIN']);
    if (denied) return denied;
    const userAuth = auth!;

    const settingsBody = (body || {}) as TenantSettingsBody;
    const tenantId = effectiveTenantId(userAuth, settingsBody.tenantId);
    const accessDenied = requireTenantAccess(userAuth, tenantId);
    if (accessDenied) return accessDenied;

    const update: Record<string, unknown> = { ...settingsBody, tenantId, updatedAt: new Date() };
    delete update.id;
    delete update._id;
    // Feature flag dan toleransi kontrol hanya diubah MASTER; ADMIN tenant tidak boleh melonggarkan kontrolnya sendiri.
    if (!userAuth.isMaster) {
      delete update.features;
      for (const key of TOLERANCE_SETTINGS) delete update[key];
    } else {
      if (THREE_WAY_QTY_TOLERANCE_SETTING in update) {
        const tolerance = normalizeThreeWayTolerancePct(update[THREE_WAY_QTY_TOLERANCE_SETTING], DEFAULT_QTY_TOLERANCE_PCT);
        if (tolerance === null) return err('Toleransi qty 3-way match harus angka 0–20 (%)', 400);
        update[THREE_WAY_QTY_TOLERANCE_SETTING] = tolerance;
      }
      if (THREE_WAY_PRICE_TOLERANCE_SETTING in update) {
        const tolerance = normalizeThreeWayTolerancePct(update[THREE_WAY_PRICE_TOLERANCE_SETTING], DEFAULT_PRICE_TOLERANCE_PCT);
        if (tolerance === null) return err('Toleransi harga 3-way match harus angka 0–20 (%)', 400);
        update[THREE_WAY_PRICE_TOLERANCE_SETTING] = tolerance;
      }
      if (RL_OVER_TOLERANCE_SETTING in update) {
        const tolerance = normalizeRlOverIssueTolerancePct(update[RL_OVER_TOLERANCE_SETTING]);
        if (tolerance === null) return err('Toleransi RL melebihi acuan harus angka 0–100 (%)', 400);
        update[RL_OVER_TOLERANCE_SETTING] = tolerance;
      }
      if (PO_OVER_RECEIVE_TOLERANCE_SETTING in update) {
        const tolerance = normalizePoOverReceiveTolerancePct(update[PO_OVER_RECEIVE_TOLERANCE_SETTING]);
        if (tolerance === null) return err('Toleransi lebih terima PO harus angka 0–100 (%)', 400);
        update[PO_OVER_RECEIVE_TOLERANCE_SETTING] = tolerance;
      }
      const features = update.features as Record<string, unknown> | undefined;
      if (features && features.pblReferenceMode === true && features.rlFromPoReference !== true) {
        return err('PBL acuan wajib bersama "RL dari acuan PO" — aktifkan keduanya', 400);
      }
    }

    if (update.logoBase64 && String(update.logoBase64).length > 700000) {
      return err('Logo terlalu besar (max 500KB). Coba kompres dulu.', 400);
    }
    if (update.logoBase64 && String(update.logoBase64).startsWith('data:image')) {
      const stored = await storeBase64Image(tenantId, String(update.logoBase64), { prefix: 'logo' });
      if ('error' in stored) return err(stored.error, 400);
      update.logoUrl = stored.url;
      update.logoMediaFile = stored.filename;
      update.logoBase64 = '';
    }

    const controlKeys = ['features', ...TOLERANCE_SETTINGS].filter((k) => k in update);
    // Flag & toleransi mengubah perilaku posting stok — perubahan dan auditnya atomik.
    const doc = await runInTransactionOrFallback(async ({ db: txDb, session }) => {
      const before = controlKeys.length
        ? await txDb.collection('tenant_settings').findOne(
          { tenantId },
          { projection: Object.fromEntries(controlKeys.map((k) => [k, 1])), ...txOpts(session) },
        )
        : null;

      await txDb.collection('tenant_settings').updateOne({ tenantId }, { $set: update }, { upsert: true, ...txOpts(session) });
      const after = await txDb.collection<TenantSettingsDoc>('tenant_settings').findOne({ tenantId }, txOpts(session));

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const beforeFeatures = (before?.features || {}) as Record<string, unknown>;
      const afterFeatures = (after?.features || {}) as Record<string, unknown>;
      if (controlKeys.includes('features')) {
        for (const key of new Set([...Object.keys(beforeFeatures), ...Object.keys(afterFeatures)])) {
          if (beforeFeatures[key] !== afterFeatures[key]) {
            changes[`features.${key}`] = { from: beforeFeatures[key] ?? null, to: afterFeatures[key] ?? null };
          }
        }
      }
      for (const key of TOLERANCE_SETTINGS) {
        if (controlKeys.includes(key) && before?.[key] !== after?.[key]) {
          changes[key] = { from: before?.[key] ?? null, to: after?.[key] ?? null };
        }
      }
      if (Object.keys(changes).length) {
        await writeAuditLog(txDb, {
          tenantId,
          action: 'TENANT_CONTROLS_UPDATE',
          entityType: 'tenant_settings',
          entityId: tenantId,
          summary: `Kontrol tenant diubah: ${Object.keys(changes).join(', ')}`,
          userId: userAuth.userId,
          userName: userAuth.name || userAuth.email || 'System',
          metadata: { changes },
        }, session);
      }
      return after;
    });
    await invalidateDashboardSnapshot(db, tenantId);
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
      logoUrl: string;
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
        logoUrl: s.logoUrl || '',
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
          logoUrl: '',
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
      logoBase64: '',
      logoUrl: '',
      ppnPercent: 11,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (createBody.logoBase64 && String(createBody.logoBase64).startsWith('data:image')) {
      const stored = await storeBase64Image(tenantId, String(createBody.logoBase64), { prefix: 'logo' });
      if ('error' in stored) return err(stored.error, 400);
      settings.logoUrl = stored.url;
      settings.logoMediaFile = stored.filename;
    } else if (createBody.logoBase64) {
      settings.logoBase64 = createBody.logoBase64;
    }
    await db.collection('tenant_settings').insertOne(settings);
    await bootstrapTenantMasterData(db, tenantId, {
      includeProducts: createBody.seedDemoProducts === true,
      actor: auth ? { userId: auth.userId, userName: auth.name || auth.email, role: auth.role } : null,
    });
    return ok(clean(settings));
  }

  if (path[0] === 'tenants' && path.length === 2 && method === 'DELETE') {
    const denied = requireMaster(auth);
    if (denied) return denied;

    const confirmErr = requireProductionConfirmPhrase(body, TENANT_PURGE_CONFIRM_PHRASE, url);
    if (confirmErr) return err(confirmErr, 400);

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
    auditDangerousRouteAccess({
      route,
      method,
      kind: 'tenant_purge',
      allowed: true,
      auth,
    });
    return ok({
      message: 'deleted',
      tenantId,
      usersDeleted: purge.counts?.users ?? 0,
      counts: purge.counts,
    });
  }

  return null;
}
