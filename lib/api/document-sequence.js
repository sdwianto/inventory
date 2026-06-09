// Nomor dokumen berurutan per tenant (SO, DO, INV, dll.).

export async function nextDocNumber(db, tenantId, docType, prefix) {
  const tid = tenantId || 'default';
  const result = await db.collection('document_sequences').findOneAndUpdate(
    { tenantId: tid, docType },
    {
      $inc: { lastNumber: 1 },
      $setOnInsert: { prefix, createdAt: new Date() },
      $set: { updatedAt: new Date() },
    },
    { upsert: true, returnDocument: 'after' },
  );
  const n = result?.lastNumber || 1;
  const p = result?.prefix || prefix;
  const yy = String(new Date().getFullYear()).slice(-2);
  const mm = String(new Date().getMonth() + 1).padStart(2, '0');
  return `${p}${yy}${mm}${String(n).padStart(6, '0')}`;
}
