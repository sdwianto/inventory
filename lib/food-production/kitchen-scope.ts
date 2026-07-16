/**
 * Resolve optional kitchen filter for Food Production list APIs.
 * Priority: query ?kitchenId= → header x-acting-kitchen-id → (none = all kitchens).
 */

export function resolveKitchenIdFilter(
  url: URL,
  request?: Request | null,
): string | undefined {
  const fromQuery = String(url.searchParams.get('kitchenId') || '').trim();
  if (fromQuery) return fromQuery;
  const fromHeader = String(request?.headers.get('x-acting-kitchen-id') || '').trim();
  return fromHeader || undefined;
}
