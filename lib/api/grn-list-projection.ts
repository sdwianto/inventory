/** Projection & strip field berat untuk list GRN — hemat bandwidth. */

const GRN_LIST_EXCLUDE = { vendorDeliverySnapshot: 0 } as const;

export { GRN_LIST_EXCLUDE };

export function stripGrnListRow(doc: Record<string, unknown>): Record<string, unknown> {
  if (!doc.vendorDeliverySnapshot) return doc;
  const { vendorDeliverySnapshot: _snap, ...rest } = doc;
  void _snap;
  return rest;
}
