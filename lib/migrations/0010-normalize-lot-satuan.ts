import type { ClientSession, Db } from 'mongodb';
import type { Migration } from '@/lib/migrations/types';
import { writeAuditLog } from '@/lib/api/audit-log';
import { runInTransactionOnDb, txOpts } from '@/lib/api/transaction';
import { INGREDIENT_LOTS_COLLECTION } from '@/lib/food-production/ingredient-lot';
import { LOT_INSPECTIONS_COLLECTION } from '@/lib/stock-ledger/lot-qc';
import { PRODUCT_UOM_COLLECTION } from '@/lib/uom/types';

export const NORMALIZE_LOT_SATUAN_ID = '0010-normalize-lot-satuan';

type Fix = { collection: string; id: string; productId: string; from: string; to: string };

function norm(s: unknown): string {
  return String(s ?? '').trim();
}

/** Satuan dasar per produk: UOM isBase, fallback products.satuan. */
async function loadBaseSatuan(
  db: Db,
  tenantId: string,
  productIds: string[],
  session?: ClientSession,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!productIds.length) return out;
  const products = await db.collection('products')
    .find({ tenantId, id: { $in: productIds } }, { projection: { id: 1, satuan: 1 }, ...txOpts(session) })
    .toArray();
  for (const p of products) {
    const s = norm(p.satuan);
    if (s) out.set(String(p.id), s);
  }
  const bases = await db.collection(PRODUCT_UOM_COLLECTION)
    .find({ tenantId, productId: { $in: productIds }, isBase: true, aktif: { $ne: false } }, { projection: { productId: 1, satuan: 1 }, ...txOpts(session) })
    .toArray();
  for (const u of bases) {
    const s = norm(u.satuan);
    if (s) out.set(String(u.productId), s);
  }
  return out;
}

async function planLotSatuan(db: Db, tenantId: string, session?: ClientSession): Promise<Fix[]> {
  const cols = [INGREDIENT_LOTS_COLLECTION, LOT_INSPECTIONS_COLLECTION];
  const docsByCol = await Promise.all(cols.map((c) => db.collection(c)
    .find({ tenantId }, { projection: { id: 1, productId: 1, satuan: 1 }, ...txOpts(session) })
    .toArray()));
  const productIds = [...new Set(docsByCol.flat().map((d) => String(d.productId || '')).filter(Boolean))];
  const baseBy = await loadBaseSatuan(db, tenantId, productIds, session);
  const fixes: Fix[] = [];
  cols.forEach((collection, i) => {
    for (const d of docsByCol[i]) {
      const to = baseBy.get(String(d.productId || ''));
      const from = norm(d.satuan);
      if (!to || from.toUpperCase() === to.toUpperCase()) continue;
      fixes.push({ collection, id: String(d.id), productId: String(d.productId), from, to });
    }
  });
  return fixes;
}

function summarize(fixes: Fix[]) {
  const byPair: Record<string, number> = {};
  const byCollection: Record<string, number> = {};
  for (const f of fixes) {
    const k = `${f.collection}: ${f.from || '(kosong)'} -> ${f.to}`;
    byPair[k] = (byPair[k] || 0) + 1;
    byCollection[f.collection] = (byCollection[f.collection] || 0) + 1;
  }
  return { total: fixes.length, byCollection, byPair };
}

/**
 * Qty lot & inspeksi QC selalu dalam satuan dasar, tetapi lot GRN lama menyimpan satuan terima
 * (mis. 30 "KG" padahal 30 ONS). Label disamakan ke satuan dasar produk; nilai lama disimpan di
 * `satuanLegacy`. Qty tidak disentuh. Satu transaksi + audit. Idempoten.
 */
export const normalizeLotSatuanMigration: Migration = {
  id: NORMALIZE_LOT_SATUAN_ID,
  description: 'Samakan satuan lot & inspeksi QC dengan satuan dasar produk (qty lot selalu base)',
  async run(ctx) {
    const { db, tenantId } = ctx;
    const actor = ctx.actor || 'system';
    const fixes = await planLotSatuan(db, tenantId);
    const before = { ...summarize(fixes), sample: fixes.slice(0, 200) };
    if (ctx.dryRun || !fixes.length) {
      return {
        summary: `${fixes.length} dokumen lot/inspeksi akan disamakan ke satuan dasar`,
        before,
        after: null,
        changed: 0,
      };
    }
    const applied = await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const fresh = await planLotSatuan(txDb, tenantId, session);
      let changed = 0;
      const byCollection = new Map<string, Fix[]>();
      for (const f of fresh) {
        const list = byCollection.get(f.collection) || [];
        list.push(f);
        byCollection.set(f.collection, list);
      }
      for (const [collection, list] of byCollection) {
        const r = await txDb.collection(collection).bulkWrite(
          list.map((f) => ({
            updateOne: {
              filter: { tenantId, id: f.id },
              update: [{
                $set: {
                  satuan: f.to,
                  satuanLegacy: { $ifNull: ['$satuanLegacy', f.from] },
                  updatedAt: ctx.now,
                },
              }],
            },
          })),
          { ordered: false, ...txOpts(session) },
        );
        changed += r.modifiedCount;
      }
      const summary = summarize(fresh);
      await writeAuditLog(txDb, {
        tenantId,
        action: 'LOT_SATUAN_NORMALIZE',
        entityType: 'tenant',
        entityId: tenantId,
        summary: `Satuan lot/inspeksi disamakan ke satuan dasar: ${changed} dokumen`,
        metadata: { migration: NORMALIZE_LOT_SATUAN_ID, ...summary },
        userId: `migration:${actor}`,
        userName: `Migrasi (${actor})`,
      }, session);
      return { changed, ...summary };
    });
    const remaining = await planLotSatuan(db, tenantId);
    return {
      summary: `${applied.changed} dokumen lot/inspeksi disamakan ke satuan dasar, ${remaining.length} tersisa`,
      before,
      after: { ...applied, remaining: remaining.length },
      changed: applied.changed,
    };
  },
};
