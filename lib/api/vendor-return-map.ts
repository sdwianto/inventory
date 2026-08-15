/**
 * Map hutang/invoice lines → RTV lines with local product + UOM identity.
 * Sales lineId + vendor uomId wajib — tidak menebak satuan.
 */

import type { Db } from 'mongodb';
import { listProductUomsByProductIds } from '@/lib/api/product-uom';
import { resolveLineQtyBaseFromUoms } from '@/lib/uom/resolve-line-qty';
import { isValidWarehouseKode } from '@/lib/api/warehouses';
import { vendorReturnLineKey } from '@/types/vendor-return';
import type { VendorReturnLine } from '@/types/vendor-return';
import { buildReturableLines, type HutangLike, type PostedReturnLike } from '@/lib/api/vendor-return-returable';

type ProductRow = {
  id?: string;
  kode?: string;
  nama?: string;
  vendorStokId?: string;
  gudangKode?: string;
  aktif?: boolean;
};

export function hutangLineIdentityError(line: {
  lineId?: string;
  uomId?: string;
  kode?: string;
  nama?: string;
}): string | null {
  const kode = String(line.kode || line.nama || '').trim() || 'baris invoice';
  if (!String(line.lineId || '').trim()) {
    return `Hutang lama tanpa lineId (${kode}) — tidak bisa diretur. Identitas baris invoice wajib.`;
  }
  if (!String(line.uomId || '').trim()) {
    return `Hutang tanpa uomId (${kode}) — satuan tidak ditebak.`;
  }
  return null;
}

async function findLocalProduct(
  db: Db,
  tenantId: string,
  salesStokId: string,
  kode: string,
  cache: Map<string, ProductRow | null>,
): Promise<ProductRow | null> {
  const cacheKey = `${salesStokId}::${kode}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) || null;

  const col = db.collection('products');
  let found: ProductRow | null = null;
  if (salesStokId) {
    found = await col.findOne({
      tenantId,
      vendorStokId: salesStokId,
      aktif: { $ne: false },
    }) as ProductRow | null;
    if (!found) {
      found = await col.findOne({
        tenantId,
        id: salesStokId,
        aktif: { $ne: false },
      }) as ProductRow | null;
    }
  }
  if (!found && kode) {
    found = await col.findOne({
      tenantId,
      kode,
      aktif: { $ne: false },
    }) as ProductRow | null;
  }
  cache.set(cacheKey, found);
  return found;
}

export async function buildVendorReturnLinesFromHutang(
  db: Db,
  tenantId: string,
  hutang: HutangLike,
  postedReturns: PostedReturnLike[],
  opts?: { excludeReturnId?: string; defaultGudangKode?: string },
): Promise<{ items: VendorReturnLine[]; skipped: string[] }> {
  const returable = buildReturableLines(hutang, postedReturns, opts);
  const skipped: string[] = [];
  const productCache = new Map<string, ProductRow | null>();
  const candidates: Array<{
    row: (typeof returable)[number];
    product: ProductRow;
  }> = [];

  for (const row of returable) {
    const ident = hutangLineIdentityError({
      lineId: row.invoiceLineId,
      uomId: row.uomId,
      kode: row.kode,
      nama: row.nama,
    });
    if (ident) {
      skipped.push(ident);
      continue;
    }
    if (row.maxQty <= 0) continue;
    const product = await findLocalProduct(db, tenantId, row.salesStokId, row.kode, productCache);
    if (!product?.id) {
      skipped.push(`Produk lokal tidak ditemukan untuk ${row.kode || row.salesStokId}`);
      continue;
    }
    candidates.push({ row, product });
  }

  const productIds = [...new Set(candidates.map((c) => String(c.product.id)))];
  const uomsByProduct = await listProductUomsByProductIds(db, tenantId, productIds);
  const items: VendorReturnLine[] = [];
  const defaultWh = opts?.defaultGudangKode || 'GKERING';

  for (const { row, product } of candidates) {
    const uoms = uomsByProduct.get(String(product.id)) || [];
    const vendorUomId = String(row.uomId || '').trim();
    const satuan = String(row.satuan || '').trim().toUpperCase();
    const localUom = uoms.find((u) => String(u.vendorUomId || '') === vendorUomId)
      || uoms.find((u) => String(u.satuan || '').toUpperCase() === satuan);
    if (!localUom) {
      skipped.push(`Satuan lokal tidak cocok untuk ${row.kode} (vendor uom ${vendorUomId || satuan})`);
      continue;
    }
    const resolved = resolveLineQtyBaseFromUoms({
      qty: row.maxQty,
      uomId: localUom.id,
      satuan: localUom.satuan,
    }, uoms);
    if ('error' in resolved) {
      skipped.push(`${row.kode}: ${resolved.error}`);
      continue;
    }
    const gudang = isValidWarehouseKode(String(product.gudangKode || ''))
      ? String(product.gudangKode)
      : defaultWh;
    const harga = row.harga || 0;
    items.push({
      lineId: vendorReturnLineKey({ invoiceLineId: row.invoiceLineId }),
      invoiceLineId: row.invoiceLineId,
      localStokId: String(product.id),
      localKode: String(product.kode || row.kode),
      localNama: String(product.nama || row.nama),
      vendorKode: row.kode,
      satuan: resolved.satuan || localUom.satuan,
      uomId: resolved.uomId || localUom.id,
      vendorUomId,
      factorToBase: resolved.factorToBase,
      qty: row.maxQty,
      qtyBase: resolved.qtyBase,
      harga,
      jumlah: Math.round(row.maxQty * harga),
      gudangKode: gudang,
      maxQty: row.maxQty,
    });
  }

  return { items, skipped };
}
