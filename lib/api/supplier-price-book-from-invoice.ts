import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { ensureVendorSupplier } from '@/lib/api/vendor-supplier';
import {
  SUPPLIER_PRICE_BOOK_COLLECTION,
  normalizeHargaBeliBook,
  type SupplierPriceBookDoc,
} from '@/lib/food-production/supplier-price-book';

type Loose = Record<string, unknown>;

function asIsoDate(raw: unknown): string {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function lineHarga(line: Loose): number | null {
  const harga = normalizeHargaBeliBook(line.harga ?? line.hargaSatuan ?? line.hargaBeli);
  return typeof harga === 'number' ? harga : null;
}

function lineKode(line: Loose): string {
  return String(line.kode || line.vendorKode || line.localKode || '').trim();
}

/** Prefer local product id; ignore vendor stokId alone. */
export function pickLocalProductId(line: Loose, grnLine?: Loose | null): string {
  const candidates = [
    line.localStokId,
    line.productId,
    grnLine?.localStokId,
    grnLine?.productId,
  ];
  for (const c of candidates) {
    const id = String(c || '').trim();
    if (id) return id;
  }
  return '';
}

export async function resolveSupplierForHutang(
  db: Db,
  hutang: Loose,
): Promise<{ id: string; kode?: string; nama?: string } | null> {
  const tid = String(hutang.tenantId || 'default');
  const supplierId = String(hutang.supplierId || '').trim();
  if (supplierId) {
    const s = await db.collection('supplier').findOne({ tenantId: tid, id: supplierId });
    if (s) {
      return {
        id: String(s.id),
        kode: s.kode != null ? String(s.kode) : undefined,
        nama: String(s.nama || s.name || ''),
      };
    }
  }
  const vendorTenantId = String(hutang.vendorTenantId || '').trim();
  if (!vendorTenantId) return null;
  const vendorName = String(
    hutang.supplierName
    || hutang.vendorName
    || (hutang.vendorBillingSnapshot as Loose | undefined)?.companyName
    || '',
  );
  const s = await ensureVendorSupplier(db, tid, vendorTenantId, vendorName);
  return { id: s.id, kode: s.kode, nama: s.nama };
}

async function loadGrnByKode(db: Db, hutang: Loose): Promise<Map<string, Loose>> {
  const tid = String(hutang.tenantId || 'default');
  const map = new Map<string, Loose>();
  const noDO = String(hutang.noDO || '').trim();
  if (!noDO) return map;
  const grn = await db.collection('goods_receipts').findOne({
    tenantId: tid,
    noDO,
    status: 'POSTED',
  }) as Loose | null
    || await db.collection('goods_receipts').findOne({ tenantId: tid, noDO }) as Loose | null;
  for (const it of (Array.isArray(grn?.items) ? grn!.items as Loose[] : [])) {
    for (const k of [it.vendorKode, it.localKode, it.kode].filter(Boolean).map(String)) {
      map.set(k, it);
    }
  }
  return map;
}

async function resolveProduct(
  db: Db,
  tid: string,
  line: Loose,
  grnByKode: Map<string, Loose>,
  vendorTenantId: string,
): Promise<{ id: string; kode?: string; nama?: string; satuan?: string } | null> {
  const kode = lineKode(line);
  const grnLine = kode ? grnByKode.get(kode) : null;
  const localId = pickLocalProductId(line, grnLine);
  if (localId) {
    const p = await db.collection('products').findOne({ tenantId: tid, id: localId });
    if (p) {
      return {
        id: String(p.id),
        kode: p.kode != null ? String(p.kode) : undefined,
        nama: p.nama != null ? String(p.nama) : undefined,
        satuan: p.satuan != null ? String(p.satuan) : undefined,
      };
    }
  }
  if (!kode) return null;
  const filter: Record<string, unknown> = { tenantId: tid, kode };
  if (vendorTenantId) {
    const withVendor = await db.collection('products').findOne({ ...filter, vendorTenantId });
    if (withVendor) {
      return {
        id: String(withVendor.id),
        kode: withVendor.kode != null ? String(withVendor.kode) : undefined,
        nama: withVendor.nama != null ? String(withVendor.nama) : undefined,
        satuan: withVendor.satuan != null ? String(withVendor.satuan) : undefined,
      };
    }
  }
  const p = await db.collection('products').findOne(filter);
  if (!p) return null;
  return {
    id: String(p.id),
    kode: p.kode != null ? String(p.kode) : undefined,
    nama: p.nama != null ? String(p.nama) : undefined,
    satuan: p.satuan != null ? String(p.satuan) : undefined,
  };
}

export type PriceBookUpsertStats = {
  upserted: number;
  skipped: number;
  invoiceNo?: string;
};

/** Upsert active price-book rows from one hutang/invoice document. */
export async function upsertSupplierPriceBookFromHutang(
  db: Db,
  hutang: Loose,
): Promise<PriceBookUpsertStats> {
  const tid = String(hutang.tenantId || 'default');
  const items = Array.isArray(hutang.items) ? hutang.items as Loose[] : [];
  const invoiceNo = String(hutang.noInvoice || hutang.noHutang || hutang.id || '');
  if (!items.length) return { upserted: 0, skipped: 0, invoiceNo };

  const supplier = await resolveSupplierForHutang(db, hutang);
  if (!supplier) return { upserted: 0, skipped: items.length, invoiceNo };

  const grnByKode = await loadGrnByKode(db, hutang);
  const vendorTenantId = String(hutang.vendorTenantId || '').trim();
  const effectiveFrom = asIsoDate(
    hutang.postedAt || hutang.approvedAt || hutang.tanggal || hutang.createdAt,
  );
  const catatan = `Dari invoice ${invoiceNo || '—'}`.slice(0, 120);

  let upserted = 0;
  let skipped = 0;
  const now = new Date();

  for (const line of items) {
    const harga = lineHarga(line);
    if (harga == null) {
      skipped += 1;
      continue;
    }
    const product = await resolveProduct(db, tid, line, grnByKode, vendorTenantId);
    if (!product) {
      skipped += 1;
      continue;
    }

    const existing = await db.collection(SUPPLIER_PRICE_BOOK_COLLECTION).findOne({
      tenantId: tid,
      supplierId: supplier.id,
      productId: product.id,
      aktif: true,
    }) as SupplierPriceBookDoc | null;

    if (existing) {
      const prevFrom = String(existing.effectiveFrom || '').trim();
      // Keep newer invoice price; skip older invoices during bulk sync.
      if (prevFrom && prevFrom > effectiveFrom) {
        skipped += 1;
        continue;
      }
      await db.collection(SUPPLIER_PRICE_BOOK_COLLECTION).updateOne(
        { id: existing.id },
        {
          $set: {
            harga,
            effectiveFrom,
            supplierKode: supplier.kode,
            supplierNama: supplier.nama,
            productKode: product.kode,
            productNama: product.nama,
            satuan: product.satuan,
            catatan,
            updatedAt: now,
          },
        },
      );
      upserted += 1;
      continue;
    }

    const doc: SupplierPriceBookDoc = {
      id: uuidv4(),
      tenantId: tid,
      supplierId: supplier.id,
      supplierKode: supplier.kode,
      supplierNama: supplier.nama,
      productId: product.id,
      productKode: product.kode,
      productNama: product.nama,
      satuan: product.satuan,
      harga,
      effectiveFrom,
      aktif: true,
      catatan,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.collection(SUPPLIER_PRICE_BOOK_COLLECTION).insertOne(doc);
      upserted += 1;
    } catch (e: unknown) {
      if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
        await db.collection(SUPPLIER_PRICE_BOOK_COLLECTION).updateOne(
          { tenantId: tid, supplierId: supplier.id, productId: product.id, aktif: true },
          {
            $set: {
              harga,
              effectiveFrom,
              catatan,
              updatedAt: now,
            },
          },
        );
        upserted += 1;
      } else {
        skipped += 1;
      }
    }
  }

  return { upserted, skipped, invoiceNo };
}

const SYNCABLE_APPROVAL = new Set([
  'PENDING_REVIEW',
  'APPROVED',
  'OUTSTANDING',
  'PARTIAL',
  'LUNAS',
  'PAID_EXTERNAL',
]);

/** Backfill price book from approved/payable vendor invoices. */
export async function syncSupplierPriceBookFromInvoices(
  db: Db,
  tenantId: string,
): Promise<{ invoices: number; upserted: number; skipped: number }> {
  const tid = tenantId || 'default';
  const list = await db.collection('hutang')
    .find({
      tenantId: tid,
      $or: [
        { approvalStatus: { $in: [...SYNCABLE_APPROVAL] } },
        { status: { $in: [...SYNCABLE_APPROVAL] } },
      ],
      items: { $exists: true, $ne: [] },
    })
    .sort({ postedAt: 1, approvedAt: 1, createdAt: 1 })
    .limit(500)
    .toArray();

  let upserted = 0;
  let skipped = 0;
  for (const h of list) {
    const stats = await upsertSupplierPriceBookFromHutang(db, h as Loose);
    upserted += stats.upserted;
    skipped += stats.skipped;
  }
  return { invoices: list.length, upserted, skipped };
}
