// Migrasi sekali: tenantId 'default' → 'sppg' (inventory customer).

const FROM = 'default';
const TO = 'sppg';
const TENANT_DISPLAY_NAME = 'SPPG Penarukan 2';

const UNIQUE_KEY_FIELDS = {
  products: 'kode',
  supplier: 'kode',
  pelanggan: 'kode',
  members: 'kodeKartu',
  rekening: 'kode',
  lokasi: 'kode',
};

const COLLECTIONS = [
  'products', 'supplier', 'pelanggan', 'members', 'rekening', 'lokasi',
  'transactions', 'sales_orders', 'deliveries', 'invoices', 'purchase_orders',
  'pembelian', 'hutang', 'hutang_pembayaran', 'piutang', 'piutang_pembayaran',
  'stok_kartu', 'penyesuaian_stok', 'produksi', 'transfer_stok', 'jurnal',
  'kas_masuk', 'kas_keluar', 'retur_penjualan', 'retur_pembelian', 'aset_tetap',
  'member_poin', 'penyusutan_log', 'tutup_buku_log', 'stok_lokasi',
  'goods_receipts', 'vendor_product_map', 'webhook_inbox',
  'customer_price_lists', 'document_sequences', 'users',
];

const SETTINGS_COLLECTION = 'tenant_settings';

async function migrateCollection(db, name) {
  const keyField = UNIQUE_KEY_FIELDS[name];
  const defaultDocs = await db.collection(name).find({ tenantId: FROM }).toArray();
  if (!defaultDocs.length) return { moved: 0, deleted: 0 };

  let moved = 0;
  let deleted = 0;
  for (const doc of defaultDocs) {
    if (keyField && doc[keyField] != null) {
      const dup = await db.collection(name).findOne({ tenantId: TO, [keyField]: doc[keyField] });
      if (dup) {
        await db.collection(name).deleteOne({ _id: doc._id });
        deleted += 1;
        continue;
      }
    }
    await db.collection(name).updateOne({ _id: doc._id }, { $set: { tenantId: TO } });
    moved += 1;
  }
  return { moved, deleted };
}

async function countDefaultLeftovers(db) {
  let total = await db.collection(SETTINGS_COLLECTION).countDocuments({ tenantId: FROM });
  for (const name of COLLECTIONS) {
    total += await db.collection(name).countDocuments({ tenantId: FROM });
  }
  return total;
}

async function mergeDefaultSettingsIntoSppg(db) {
  const legacy = await db.collection('tenant_settings').findOne({ tenantId: FROM });
  if (!legacy) return false;

  const target = await db.collection('tenant_settings').findOne({ tenantId: TO });
  const patch = {};
  if (legacy.logoBase64 && !target?.logoBase64) patch.logoBase64 = legacy.logoBase64;
  if (legacy.companyAddress && !target?.companyAddress) patch.companyAddress = legacy.companyAddress;
  if (legacy.companyPhone && !target?.companyPhone) patch.companyPhone = legacy.companyPhone;
  if (legacy.companyNPWP && !target?.companyNPWP) patch.companyNPWP = legacy.companyNPWP;

  if (Object.keys(patch).length) {
    await db.collection('tenant_settings').updateOne(
      { tenantId: TO },
      { $set: { ...patch, updatedAt: new Date() } },
      { upsert: true },
    );
  }
  await db.collection('tenant_settings').deleteMany({ tenantId: FROM });
  return true;
}

export async function ensureDefaultRenamedToSppg(db, { force = false } = {}) {
  const logCol = db.collection('app_migrations');
  const done = await logCol.findOne({ id: 'default-to-sppg', done: true });
  const leftovers = await countDefaultLeftovers(db);

  if (done && leftovers === 0 && !force) {
    const cleanedLegacy = await mergeDefaultSettingsIntoSppg(db);
    return { skipped: true, reason: 'already migrated', cleanedLegacy };
  }

  const counts = {};
  for (const name of COLLECTIONS) {
    const r = await migrateCollection(db, name);
    if (r.moved || r.deleted) counts[name] = r;
  }

  await db.collection('users').updateMany(
    { tenantId: TO },
    { $set: { tenantName: TENANT_DISPLAY_NAME } },
  );

  let settings = await db.collection('tenant_settings').findOne({ tenantId: TO });
  if (settings) {
    const companyName = !settings.companyName || settings.companyName === FROM
      ? TENANT_DISPLAY_NAME
      : settings.companyName;
    await db.collection('tenant_settings').updateOne(
      { tenantId: TO },
      { $set: { companyName, tenantName: TENANT_DISPLAY_NAME, updatedAt: new Date() } },
    );
  } else {
    await db.collection('tenant_settings').insertOne({
      tenantId: TO,
      companyName: TENANT_DISPLAY_NAME,
      tenantName: TENANT_DISPLAY_NAME,
      receiptFooterText: 'Terima Kasih',
      showLogoOnReceipt: true,
      showLogoOnInvoice: true,
      ppnPercent: 11,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  const cleanedLegacy = await mergeDefaultSettingsIntoSppg(db);

  await logCol.updateOne(
    { id: 'default-to-sppg' },
    { $set: { done: true, at: new Date(), counts, cleanedLegacy } },
    { upsert: true },
  );
  return { migrated: true, counts, cleanedLegacy };
}
