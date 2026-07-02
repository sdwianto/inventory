/** Filter MongoDB hutang — shared nav-badges, list, pending-count, dashboard. */

export function vendorInvoiceFilter(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    $or: [
      { referenceType: 'VENDOR_INVOICE' },
      { vendorInvoiceId: { $exists: true, $ne: null } },
    ],
  };
  if (!extra || Object.keys(extra).length === 0) return base;
  return { $and: [base, extra] };
}

export function approvalStatusFilter(approvalStatus: string): Record<string, unknown> {
  if (!approvalStatus) return {};
  if (approvalStatus === 'PENDING_REVIEW') {
    return {
      $or: [
        { approvalStatus: 'PENDING_REVIEW' },
        { status: 'PENDING_REVIEW', approvalStatus: { $exists: false } },
      ],
    };
  }
  return { approvalStatus };
}

export function payableHutangFilter(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const maintenance = { referenceType: 'MAINTENANCE_SERVICE', ...extra };
  const vendor = vendorInvoiceFilter(extra);
  return { $or: [maintenance, vendor] };
}

/** Hutang vendor invoice menunggu review admin — dipakai badge & pending-count. */
export function hutangPendingReviewFilter(): Record<string, unknown> {
  return payableHutangFilter(approvalStatusFilter('PENDING_REVIEW'));
}

/** Strip logo base64 dari snapshot untuk response list (hemat bandwidth). */
export function stripHutangListSnapshot(doc: Record<string, unknown>): Record<string, unknown> {
  const snap = doc.vendorBillingSnapshot as Record<string, unknown> | undefined;
  if (!snap) return doc;
  const { logoBase64: _b, ...restSnap } = snap;
  return {
    ...doc,
    vendorBillingSnapshot: {
      ...restSnap,
      logoUrl: snap.logoUrl || '',
    },
  };
}
