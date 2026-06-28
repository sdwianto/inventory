'use client';

type QueryInit = URLSearchParams | Record<string, string | number | boolean | undefined>;

function toSearchParams(init: QueryInit): URLSearchParams {
  if (init instanceof URLSearchParams) return new URLSearchParams(init);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(init)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params;
}

/**
 * Build query string for non-auth params only (dates, limits).
 * Tenant/role authorization is enforced server-side via session cookie — do not pass tenantId/role.
 */
export function apiQueryParams(init: QueryInit = {}): URLSearchParams {
  const params = toSearchParams(init);
  params.delete('tenantId');
  params.delete('role');
  return params;
}

export function apiUrl(path: string, extra: QueryInit = {}): string {
  const qs = apiQueryParams(extra).toString();
  return qs ? `${path}?${qs}` : path;
}

/** @deprecated Use apiUrl — tenant scope is server-side */
export function withTenantScope(init: QueryInit = {}): URLSearchParams {
  return apiQueryParams(init);
}

/** @deprecated Use apiUrl */
export function tenantScopedUrl(path: string, extra: QueryInit = {}): string {
  return apiUrl(path, extra);
}
