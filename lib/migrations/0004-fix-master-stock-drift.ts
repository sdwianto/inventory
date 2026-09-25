import type { Db } from 'mongodb';
import type { Migration } from '@/lib/migrations/types';
import { writeAuditLog } from '@/lib/api/audit-log';
import { runInTransactionOnDb } from '@/lib/api/transaction';
import {
  STOCK_QTY_EPS,
  ledgerSaldoForProducts,
  planProductsMasterStock,
  roundStockQty,
  writeProductMasterStock,
  type MasterStockPlanRow,
} from '@/lib/stock-ledger';

export const FIX_MASTER_STOCK_DRIFT_ID = '0004-fix-master-stock-drift';

const KARTU_CHUNK = 500;

/** STOK = selisih qty nyata; NORMALISASI = tipe/pembulatan saja (≤ EPS); LABEL = hanya stokDisplay. */
export type MasterDriftKind = 'STOK' | 'NORMALISASI' | 'LABEL';

export type MasterDriftRow = {
  productId: string;
  kode: string;
  nama: string;
  aktif: boolean;
  mergedInto: string | null;
  kind: MasterDriftKind;
  masterBefore: number;
  gudang: number;
  selisih: number;
  displayBefore: string;
  displayAfter: string;
  result: 'WOULD_FIX' | 'FIXED' | 'FAILED';
  masterAfter?: number;
  error?: string;
};

export type LokasiKartuMismatch = {
  productId: string;
  kode: string;
  nama: string;
  gudang: number;
  kartu: number;
  selisih: number;
};

export function classifyMasterDrift(row: MasterStockPlanRow): MasterDriftKind | null {
  if (Math.abs(row.after.stok - row.before.stok) > STOCK_QTY_EPS) return 'STOK';
  if (row.stokChanged) return 'NORMALISASI';
  if (row.displayChanged) return 'LABEL';
  return null;
}

function driftRows(plan: MasterStockPlanRow[]): MasterDriftRow[] {
  const out: MasterDriftRow[] = [];
  for (const row of plan) {
    const kind = classifyMasterDrift(row);
    if (!kind) continue;
    out.push({
      productId: row.productId,
      kode: row.kode,
      nama: row.nama,
      aktif: row.aktif,
      mergedInto: row.mergedInto,
      kind,
      masterBefore: row.before.stok,
      gudang: row.after.stok,
      selisih: roundStockQty(row.after.stok - row.before.stok),
      displayBefore: row.before.stokDisplay,
      displayAfter: row.after.stokDisplay,
      result: 'WOULD_FIX',
    });
  }
  return out;
}

/** Gudang (Σ stok_lokasi) vs saldo kartu — hanya dilaporkan; perbaikan lewat rekonsiliasi buku stok. */
async function lokasiVsKartu(db: Db, tenantId: string, plan: MasterStockPlanRow[]): Promise<LokasiKartuMismatch[]> {
  const out: LokasiKartuMismatch[] = [];
  for (let i = 0; i < plan.length; i += KARTU_CHUNK) {
    const chunk = plan.slice(i, i + KARTU_CHUNK);
    const saldo = await ledgerSaldoForProducts(db, tenantId, chunk.map((r) => r.productId));
    for (const row of chunk) {
      const info = saldo.get(row.productId);
      if (!info?.hasActivity) continue;
      const kartu = roundStockQty(info.saldo);
      if (Math.abs(kartu - row.after.stok) <= STOCK_QTY_EPS) continue;
      out.push({
        productId: row.productId,
        kode: row.kode,
        nama: row.nama,
        gudang: row.after.stok,
        kartu,
        selisih: roundStockQty(row.after.stok - kartu),
      });
    }
  }
  return out;
}

function countKinds(rows: MasterDriftRow[]) {
  return {
    stok: rows.filter((r) => r.kind === 'STOK').length,
    normalisasi: rows.filter((r) => r.kind === 'NORMALISASI').length,
    label: rows.filter((r) => r.kind === 'LABEL').length,
  };
}

/**
 * products.stok & stokDisplay = Σ stok_lokasi untuk seluruh produk tenant (termasuk nonaktif & sumber
 * vendor tergabung). Tiap produk dihitung ulang di transaksinya sendiri oleh buku stok; selisih qty
 * nyata diaudit per produk (STOCK_MASTER_RECOMPUTE). Gudang vs kartu hanya dilaporkan. Idempoten.
 */
export const fixMasterStockDriftMigration: Migration = {
  id: FIX_MASTER_STOCK_DRIFT_ID,
  description: 'Samakan stok master produk (stok + label) dengan Σ stok gudang, audit per produk',
  async run(ctx) {
    const actor = ctx.actor || 'system';
    const auditActor = { userId: `migration:${actor}`, userName: `Migrasi (${actor})` };
    const tenantId = ctx.tenantId;

    const plan = await planProductsMasterStock(ctx.db, tenantId);
    const rows = driftRows(plan);
    const mismatchBefore = await lokasiVsKartu(ctx.db, tenantId, plan);
    const before = {
      products: plan.length,
      drift: countKinds(rows),
      lokasiVsKartu: mismatchBefore.length,
    };

    let changed = 0;
    if (!ctx.dryRun) {
      for (const row of rows) {
        try {
          const written = await runInTransactionOnDb(ctx.db, async ({ db, session }) => {
            const w = await writeProductMasterStock(db, tenantId, row.productId, session);
            if (!w.found) throw new Error('Produk tidak ditemukan');
            const selisih = roundStockQty(w.stok - (w.before?.stok ?? 0));
            if (Math.abs(selisih) > STOCK_QTY_EPS) {
              await writeAuditLog(db, {
                tenantId,
                action: 'STOCK_MASTER_RECOMPUTE',
                entityType: 'product',
                entityId: row.productId,
                summary: `${row.kode || row.productId}: stok master ${w.before?.stok ?? 0} → ${w.stok} (Σ gudang)`,
                metadata: {
                  migration: FIX_MASTER_STOCK_DRIFT_ID,
                  before: w.before,
                  after: { stok: w.stok, stokDisplay: w.stokDisplay },
                  selisih,
                },
                ...auditActor,
              }, session);
            }
            return w;
          });
          row.result = 'FIXED';
          row.masterAfter = written.stok;
          changed += 1;
        } catch (e) {
          row.result = 'FAILED';
          row.error = e instanceof Error ? e.message : String(e);
        }
      }
      const cosmetic = rows.filter((r) => r.result === 'FIXED' && r.kind !== 'STOK').length;
      if (cosmetic) {
        await writeAuditLog(ctx.db, {
          tenantId,
          action: 'STOCK_MASTER_RECOMPUTE',
          entityType: 'product',
          entityId: tenantId,
          summary: `Normalisasi stok/label master ${cosmetic} produk (tanpa selisih qty)`,
          metadata: { migration: FIX_MASTER_STOCK_DRIFT_ID, productIds: rows.filter((r) => r.result === 'FIXED' && r.kind !== 'STOK').map((r) => r.productId) },
          ...auditActor,
        });
      }
    }

    const afterRows = ctx.dryRun ? rows : driftRows(await planProductsMasterStock(ctx.db, tenantId));
    const failed = rows.filter((r) => r.result === 'FAILED');
    const k = countKinds(rows);
    const verb = ctx.dryRun ? 'akan disamakan' : 'disamakan';
    return {
      summary: `${k.stok} produk selisih stok master vs gudang ${verb}`
        + (k.normalisasi ? `; ${k.normalisasi} normalisasi tipe/pembulatan` : '')
        + (k.label ? `; ${k.label} label stok` : '')
        + (failed.length ? `; ${failed.length} GAGAL` : '')
        + (ctx.dryRun ? '' : `; sisa selisih master ${countKinds(afterRows).stok}`)
        + (mismatchBefore.length ? `; ${mismatchBefore.length} produk gudang ≠ kartu (laporan saja)` : ''),
      before,
      after: {
        drift: ctx.dryRun ? before.drift : countKinds(afterRows),
        rows,
        lokasiVsKartu: mismatchBefore,
      },
      changed,
    };
  },
};
