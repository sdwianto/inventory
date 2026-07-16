import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  tenantIdForWrite,
  withTenantFilter,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import {
  SUPPLIER_PRICE_BOOK_COLLECTION,
  normalizeHargaBeliBook,
  type SupplierPriceBookDoc,
} from '@/lib/food-production/supplier-price-book';
import { FP_MANAGE_ROLES, FP_MGMT_READ_ROLES } from '@/lib/food-production/roles';
import { isIsoDate } from '@/lib/food-production/production-plan';
import type { HandlerContext } from '@/types/api/handler';

interface BookBody extends Record<string, unknown> {
  supplierId?: string;
  productId?: string;
  harga?: number;
  effectiveFrom?: string;
  effectiveTo?: string;
  aktif?: boolean;
  catatan?: string;
}

export async function handleSupplierPriceBook(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  const bookBody = (body || {}) as BookBody;

  if (route === '/supplier-price-book/options' && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_MGMT_READ_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const q = String(url.searchParams.get('q') || '').trim();
    const supplierFilter: Record<string, unknown> = {};
    const productFilter: Record<string, unknown> = {};
    if (q) {
      const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      supplierFilter.$or = [{ nama: rx }, { name: rx }, { kode: rx }];
      productFilter.$or = [{ nama: rx }, { kode: rx }];
    }

    const [suppliers, products] = await Promise.all([
      db.collection('supplier')
        .find(withTenantFilter(scopeAuth, supplierFilter))
        .project({ id: 1, kode: 1, nama: 1, name: 1 })
        .sort({ nama: 1 })
        .limit(300)
        .toArray(),
      db.collection('products')
        .find(withTenantFilter(scopeAuth, productFilter))
        .project({ id: 1, kode: 1, nama: 1, satuan: 1, hargaBeli: 1 })
        .sort({ nama: 1 })
        .limit(300)
        .toArray(),
    ]);
    return ok({
      suppliers: suppliers.map((d) => clean(d as Record<string, unknown>)),
      products: products.map((d) => clean(d as Record<string, unknown>)),
    });
  }

  if (route === '/supplier-price-book' && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_MGMT_READ_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const filter: Record<string, unknown> = {};
    if (url.searchParams.get('aktif') === '1') filter.aktif = true;
    const supplierId = String(url.searchParams.get('supplierId') || '').trim();
    if (supplierId) filter.supplierId = supplierId;
    const productId = String(url.searchParams.get('productId') || '').trim();
    if (productId) filter.productId = productId;
    const q = String(url.searchParams.get('q') || '').trim();
    if (q) {
      const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      filter.$or = [{ productNama: rx }, { productKode: rx }, { supplierNama: rx }];
    }

    const list = await db.collection(SUPPLIER_PRICE_BOOK_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ productNama: 1, harga: 1 })
      .limit(500)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/supplier-price-book' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: bookBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const supplierId = String(bookBody.supplierId || '').trim();
    const productId = String(bookBody.productId || '').trim();
    if (!supplierId) return err('supplierId wajib', 400);
    if (!productId) return err('productId wajib', 400);
    const harga = normalizeHargaBeliBook(bookBody.harga);
    if (typeof harga === 'object') return err(harga.error, 400);

    const supplier = await db.collection('supplier').findOne(
      withTenantFilter(scopeAuth, { id: supplierId }),
    );
    if (!supplier) return err('Supplier tidak ditemukan', 404);
    const resolvedSupplierId = String(supplier.id || supplierId);
    const supplierNama = String(supplier.nama || supplier.name || '');
    const supplierKode = supplier.kode != null ? String(supplier.kode) : undefined;

    const product = await db.collection('products').findOne(
      withTenantFilter(scopeAuth, { id: productId }),
    );
    if (!product) return err('Produk tidak ditemukan', 404);

    const effectiveFrom = String(bookBody.effectiveFrom || '').trim() || undefined;
    const effectiveTo = String(bookBody.effectiveTo || '').trim() || undefined;
    if (effectiveFrom && !isIsoDate(effectiveFrom)) return err('effectiveFrom YYYY-MM-DD', 400);
    if (effectiveTo && !isIsoDate(effectiveTo)) return err('effectiveTo YYYY-MM-DD', 400);
    if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) {
      return err('effectiveFrom tidak boleh setelah effectiveTo', 400);
    }

    const dup = await db.collection(SUPPLIER_PRICE_BOOK_COLLECTION).findOne(
      withTenantFilter(scopeAuth, {
        supplierId: resolvedSupplierId,
        productId,
        aktif: true,
      }),
    );
    if (dup) {
      return err('Harga aktif untuk supplier+produk sudah ada — update entri tersebut', 400);
    }

    const now = new Date();
    const doc: SupplierPriceBookDoc = {
      id: uuidv4(),
      tenantId: tenantIdForWrite(scopeAuth, bookBody),
      supplierId: resolvedSupplierId,
      supplierKode,
      supplierNama: supplierNama || undefined,
      productId,
      productKode: product.kode != null ? String(product.kode) : undefined,
      productNama: product.nama != null ? String(product.nama) : undefined,
      satuan: product.satuan != null ? String(product.satuan) : undefined,
      harga,
      effectiveFrom,
      effectiveTo,
      aktif: bookBody.aktif !== false,
      catatan: String(bookBody.catatan || '').trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.collection(SUPPLIER_PRICE_BOOK_COLLECTION).insertOne(doc);
    } catch (e: unknown) {
      if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
        return err('Harga supplier+produk sudah ada', 400);
      }
      throw e;
    }
    await writeAuditLog(db, {
      tenantId: doc.tenantId,
      action: 'SUPPLIER_PRICE_BOOK_UPSERT',
      entityType: 'supplier_price_book',
      entityId: doc.id,
      summary: `Price book ${doc.productNama || doc.productId} @ ${doc.harga} (${doc.supplierNama || doc.supplierId})`,
      ...auditActor(auth),
    });
    return ok(clean(doc as unknown as Record<string, unknown>), 201);
  }

  if (path[0] === 'supplier-price-book' && path[1] && !path[2] && method === 'PUT') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: bookBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(SUPPLIER_PRICE_BOOK_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as SupplierPriceBookDoc | null;
    if (!existing) return err('Entri price book tidak ditemukan', 404);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (bookBody.harga !== undefined) {
      const harga = normalizeHargaBeliBook(bookBody.harga);
      if (typeof harga === 'object') return err(harga.error, 400);
      update.harga = harga;
    }
    if (bookBody.effectiveFrom !== undefined) {
      const v = String(bookBody.effectiveFrom || '').trim();
      if (v && !isIsoDate(v)) return err('effectiveFrom YYYY-MM-DD', 400);
      update.effectiveFrom = v || null;
    }
    if (bookBody.effectiveTo !== undefined) {
      const v = String(bookBody.effectiveTo || '').trim();
      if (v && !isIsoDate(v)) return err('effectiveTo YYYY-MM-DD', 400);
      update.effectiveTo = v || null;
    }
    const finalFrom = bookBody.effectiveFrom !== undefined
      ? (String(bookBody.effectiveFrom || '').trim() || null)
      : (existing.effectiveFrom || null);
    const finalTo = bookBody.effectiveTo !== undefined
      ? (String(bookBody.effectiveTo || '').trim() || null)
      : (existing.effectiveTo || null);
    if (finalFrom && finalTo && finalFrom > finalTo) {
      return err('effectiveFrom tidak boleh setelah effectiveTo', 400);
    }
    if (bookBody.aktif !== undefined) update.aktif = bookBody.aktif !== false;
    if (bookBody.catatan !== undefined) {
      update.catatan = String(bookBody.catatan || '').trim() || null;
    }

    const willActivate = bookBody.aktif === true && existing.aktif === false;
    if (willActivate) {
      const dup = await db.collection(SUPPLIER_PRICE_BOOK_COLLECTION).findOne(
        withTenantFilter(scopeAuth, {
          supplierId: existing.supplierId,
          productId: existing.productId,
          aktif: true,
        }),
      );
      if (dup && String(dup.id) !== id) {
        return err('Harga aktif untuk supplier+produk sudah ada — update entri tersebut', 400);
      }
    }

    // Refresh denormalized labels from master (MINOR stale-name fix).
    const product = await db.collection('products').findOne(
      withTenantFilter(scopeAuth, { id: existing.productId }),
    );
    if (product) {
      if (product.nama != null) update.productNama = String(product.nama);
      if (product.kode != null) update.productKode = String(product.kode);
      if (product.satuan != null) update.satuan = String(product.satuan);
    }
    const supplier = await db.collection('supplier').findOne(
      withTenantFilter(scopeAuth, { id: existing.supplierId }),
    );
    if (supplier) {
      update.supplierNama = String(supplier.nama || supplier.name || '');
      if (supplier.kode != null) update.supplierKode = String(supplier.kode);
    }

    try {
      await db.collection(SUPPLIER_PRICE_BOOK_COLLECTION).updateOne(
        withTenantFilter(scopeAuth, { id }),
        { $set: update },
      );
    } catch (e: unknown) {
      if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
        return err('Harga supplier+produk sudah ada', 400);
      }
      throw e;
    }
    const saved = await db.collection(SUPPLIER_PRICE_BOOK_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'SUPPLIER_PRICE_BOOK_UPSERT',
      entityType: 'supplier_price_book',
      entityId: id,
      summary: `Price book ${existing.productNama || existing.productId} diperbarui`,
      ...auditActor(auth),
    });
    return ok(clean(saved as Record<string, unknown>));
  }

  if (path[0] === 'supplier-price-book' && path[1] && !path[2] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(SUPPLIER_PRICE_BOOK_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as SupplierPriceBookDoc | null;
    if (!existing) return err('Entri price book tidak ditemukan', 404);
    await db.collection(SUPPLIER_PRICE_BOOK_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { aktif: false, updatedAt: new Date() } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'SUPPLIER_PRICE_BOOK_DEACTIVATE',
      entityType: 'supplier_price_book',
      entityId: id,
      summary: `Price book ${existing.productNama || existing.productId} dinonaktifkan`,
      ...auditActor(auth),
    });
    return ok({ id, aktif: false });
  }

  return null;
}
