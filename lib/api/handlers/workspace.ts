import type { Db } from 'mongodb';
import { NextResponse } from 'next/server';
import { clean, okCached, err } from '@/lib/api/db';
import { sanitizeStoreSettings } from '@/lib/receipt-doc';
import { resolveOperationalScope, withTenantFilter } from '@/lib/api/tenant-master';
import { requireMaster } from '@/lib/api/require-auth';
import { bootstrapTenantMasterData } from '@/lib/api/tenant-master';
import { mergeFeatureFlags } from '@/lib/api/feature-flags';
import type { HandlerContext } from '@/types/api/handler';
import type { AuthContext } from '@/types/auth';

function okPrivate(data: unknown): NextResponse {
  return okCached(data, { maxAge: 0 });
}

function logoResponseFromDataUrl(raw: string): NextResponse | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^data:([^;]+);base64,(.+)$/i);
  if (m) {
    return new NextResponse(Buffer.from(m[2], 'base64'), {
      status: 200,
      headers: {
        'Content-Type': m[1],
        'Cache-Control': 'private, max-age=300',
      },
    });
  }
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed.slice(0, 64))) {
    return new NextResponse(Buffer.from(trimmed, 'base64'), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=300',
      },
    });
  }
  return null;
}

async function loadTenantSettings(db: Db, tenantId: string): Promise<Record<string, unknown> | null> {
  const settings = await db.collection('tenant_settings').findOne({ tenantId });
  if (!settings) return null;
  const doc = clean(settings) as Record<string, unknown>;
  return { ...doc, ...sanitizeStoreSettings(doc) };
}

async function loadLokasi(db: Db, scopeAuth: AuthContext | null, tenantId: string) {
  if (!scopeAuth || !tenantId) return [];
  const filter = withTenantFilter(scopeAuth, {});
  let list = await db.collection('lokasi').find(filter).sort({ kode: 1 }).toArray();
  if (list.length === 0 && !scopeAuth.isMaster) {
    await bootstrapTenantMasterData(db, tenantId, { includeProducts: false }).catch(() => {});
    list = await db.collection('lokasi').find(filter).sort({ kode: 1 }).toArray();
  }
  return list.map((row) => clean(row));
}

async function loadTenants(db: Db) {
  const [allSettings, users] = await Promise.all([
    db.collection('tenant_settings').find({}).project({
      tenantId: 1, companyName: 1, tenantName: 1,
    }).toArray(),
    db.collection('users').find({}).project({
      tenantId: 1, tenantName: 1,
    }).toArray(),
  ]);
  const tenantMap: Record<string, Record<string, unknown>> = {};
  for (const s of allSettings) {
    tenantMap[s.tenantId] = {
      tenantId: s.tenantId,
      tenantName: s.companyName || s.tenantId,
      companyName: s.companyName || '-',
      userCount: 0,
    };
  }
  for (const u of users) {
    const tid = u.tenantId || 'default';
    if (!tenantMap[tid]) {
      tenantMap[tid] = {
        tenantId: tid,
        tenantName: u.tenantName || tid,
        companyName: u.tenantName || tid,
        userCount: 0,
      };
    }
    tenantMap[tid].userCount = Number(tenantMap[tid].userCount || 0) + 1;
  }
  return Object.values(tenantMap).filter(
    (t) => t.tenantId !== 'default' && t.tenantId !== 'master',
  );
}

export async function handleWorkspace({
  db,
  route,
  method,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  if (method !== 'GET' || !route.startsWith('/workspace/')) return null;

  const brandTenantId = auth?.tenantId || 'default';

  if (route === '/workspace/logo') {
    const brandSettings = await loadTenantSettings(db, brandTenantId);
    const external = String(brandSettings?.logoUrl || '').trim();
    if (/^https?:\/\//i.test(external)) {
      return NextResponse.redirect(external, 302);
    }
    const img = logoResponseFromDataUrl(String(brandSettings?.logoBase64 || ''));
    if (!img) return err('Logo tidak ditemukan', 404);
    return img;
  }

  if (route !== '/workspace/bootstrap') return null;

  const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, request });
  if (denied) return denied;

  const [brandSettings, scopeSettings, lokasi, tenants] =
    await Promise.all([
      loadTenantSettings(db, brandTenantId),
      tenantId ? loadTenantSettings(db, tenantId) : Promise.resolve(null),
      tenantId && scopeAuth ? loadLokasi(db, scopeAuth, tenantId) : Promise.resolve([]),
      auth?.isMaster
        ? (async () => {
            const masterDenied = requireMaster(auth);
            if (masterDenied) return [];
            return loadTenants(db);
          })()
        : Promise.resolve([]),
    ]);

  const hasEmbeddedLogo = Boolean(String(brandSettings?.logoBase64 || '').trim());
  const externalLogo = String(brandSettings?.logoUrl || '').trim();
  const logoUrl = hasEmbeddedLogo
    ? '/api/workspace/logo'
    : (/^https?:\/\//i.test(externalLogo) ? externalLogo : '');

  return okPrivate({
    scope: {
      tenantId: tenantId || '',
      tenantLabel:
        (scopeSettings?.companyName as string)
        || (scopeSettings?.tenantName as string)
        || tenantId
        || '',
      lokasiList: lokasi,
      featureFlags: mergeFeatureFlags(scopeSettings),
    },
    branding: {
      tenantId: brandTenantId,
      companyName:
        (brandSettings?.companyName as string)
        || auth?.tenantName
        || 'Inventory App',
      logoUrl,
      logoBase64: '',
    },
    tenants,
    user: auth
      ? {
          id: auth.userId,
          email: auth.email,
          name: auth.name,
          role: auth.role,
          tenantId: auth.tenantId,
          tenantName: auth.tenantName,
          isMaster: auth.isMaster,
        }
      : null,
  });
}
