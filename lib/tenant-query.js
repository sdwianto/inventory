'use client';

/**
 * Build query string for non-auth params only (dates, limits).
 * Tenant/role authorization is enforced server-side via session cookie — do not pass tenantId/role.
 */
export function apiQueryParams(init = {}) {
  const params = init instanceof URLSearchParams ? new URLSearchParams(init) : new URLSearchParams(init);
  params.delete('tenantId');
  params.delete('role');
  return params;
}

export function apiUrl(path, extra = {}) {
  const qs = apiQueryParams(extra).toString();
  return qs ? `${path}?${qs}` : path;
}

/** @deprecated Use apiUrl — tenant scope is server-side */
export function withTenantScope(init = {}) {
  return apiQueryParams(init);
}

/** @deprecated Use apiUrl */
export function tenantScopedUrl(path, extra = {}) {
  return apiUrl(path, extra);
}
