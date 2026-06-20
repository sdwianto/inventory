// Backfill tagihan vendor lama (OUTSTANDING tanpa approvalStatus) → APPROVED.

export async function backfillLegacyVendorInvoices(db, tenantId) {
  const filter = {
    referenceType: 'VENDOR_INVOICE',
    approvalStatus: { $exists: false },
    status: { $in: ['OUTSTANDING', 'PARTIAL', 'LUNAS'] },
  };
  if (tenantId) filter.tenantId = tenantId;

  const rows = await db.collection('hutang').find(filter).toArray();
  let updated = 0;

  for (const h of rows) {
    const now = h.createdAt || new Date();
    const patch = {
      approvalStatus: h.status === 'LUNAS' ? 'PAID_EXTERNAL' : 'APPROVED',
      updatedAt: new Date(),
    };
    if (!h.approvedAt) patch.approvedAt = now;
    if (!h.approvedBy) {
      patch.approvedBy = { userId: '', userName: 'Migrasi sistem', role: 'SYSTEM' };
    }
    await db.collection('hutang').updateOne({ id: h.id }, { $set: patch });
    updated += 1;
  }

  return { updated, scanned: rows.length };
}
