// Filter data per tenant — MASTER lihat semua, role lain hanya tenant session (server auth).

/** Id tenant operasional — selalu lowercase agar query konsisten dengan integrasi sales.app. */
export function normalizeTenantId(tenantId) {
  const s = String(tenantId ?? '').trim();
  if (!s || s === 'master') return s || 'default';
  return s.toLowerCase();
}

/** Filter tenant case-insensitive (perbaikan data lama). */
export function tenantIdMatchFilter(tenantId) {
  const tid = normalizeTenantId(tenantId);
  if (tid === 'default') {
    return {
      $or: [
        { tenantId: 'default' },
        { tenantId: { $exists: false } },
        { tenantId: null },
        { tenantId: '' },
      ],
    };
  }
  const escaped = tid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { tenantId: { $regex: `^${escaped}$`, $options: 'i' } };
}

/** @deprecated Jangan dipakai untuk otorisasi — gunakan ctx.auth + tenantFilterFromAuth */
export function readTenantScope(url) {
  return {
    tenantId: (url.searchParams.get('tenantId') || '').trim(),
    role: (url.searchParams.get('role') || '').trim().toUpperCase(),
  };
}

/** MongoDB filter dari session auth. */
export function tenantFilterFromAuth(auth) {
  if (!auth) return { tenantId: '__denied__' };
  return tenantFilterForQuery(auth.tenantId, auth.role);
}

/** MongoDB filter: kosong untuk MASTER, scoped untuk ADMIN/GUDANG/SUPERVISOR/OWNER. */
export function tenantFilterForQuery(tenantId, role) {
  if (role === 'MASTER') return {};
  return tenantIdMatchFilter(tenantId);
}

export function mergeTenantScopeFromAuth(baseFilter, auth) {
  const tenantPart = tenantFilterFromAuth(auth);
  if (!tenantPart || Object.keys(tenantPart).length === 0) return baseFilter || {};
  if (!baseFilter || Object.keys(baseFilter).length === 0) return tenantPart;
  return { $and: [baseFilter, tenantPart] };
}

/** @deprecated Gunakan mergeTenantScopeFromAuth(auth) */
export function mergeTenantScope(baseFilter, url) {
  const { tenantId, role } = readTenantScope(url);
  const tenantPart = tenantFilterForQuery(tenantId, role);
  if (!tenantPart || Object.keys(tenantPart).length === 0) return baseFilter;
  if (!baseFilter || Object.keys(baseFilter).length === 0) return tenantPart;
  return { $and: [baseFilter, tenantPart] };
}

/** Cek akses dokumen tunggal (transaksi, dll.). */
export function canAccessTenantDoc(doc, tenantId, role) {
  if (role === 'MASTER') return true;
  if (!doc) return false;
  const docTid = normalizeTenantId(doc.tenantId || 'default');
  const userTid = normalizeTenantId(tenantId || 'default');
  if (userTid === 'default') {
    return !doc.tenantId || docTid === 'default';
  }
  return docTid === userTid;
}

export function assertDocTenant(doc, auth) {
  if (!doc) return false;
  return canAccessTenantDoc(doc, auth?.tenantId, auth?.role);
}

/** Paksa tenantId pada write dari session (non-MASTER tidak bisa override). */
export function injectTenantId(data, auth) {
  if (!auth) return data;
  if (auth.isMaster) {
    return {
      ...data,
      tenantId: data?.tenantId || auth.tenantId,
      tenantName: data?.tenantName || auth.tenantName,
    };
  }
  return {
    ...data,
    tenantId: auth.tenantId,
    tenantName: auth.tenantName,
  };
}
