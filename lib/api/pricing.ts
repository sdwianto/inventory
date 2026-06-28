// Resolusi harga jual: harga khusus pelanggan → tier pelanggan → tier manual.

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { findMasterDoc } from '@/lib/api/tenant-master';
import type { AuthContext } from '@/types/auth';
import type { JsonObject } from '@/types/json';

const TIER_FIELDS: Record<string, string> = {
  ECER: 'hargaEcer',
  GROSIR: 'hargaGrosir',
  SPESIAL: 'hargaSpesial',
};

export function tierField(tier: string | null | undefined): string {
  return TIER_FIELDS[String(tier || 'ECER').toUpperCase()] || 'hargaEcer';
}

export function priceFromProduct(prod: JsonObject | null | undefined, tier: string | null | undefined): number {
  const field = tierField(tier);
  return Number(prod?.[field] ?? prod?.hargaEcer ?? 0);
}

interface ResolveUnitPriceInput {
  pelangganId?: string | null;
  stokId: string;
  tierOverride?: string | null;
}

export async function resolveUnitPrice(
  db: Db,
  auth: AuthContext | null,
  { pelangganId, stokId, tierOverride }: ResolveUnitPriceInput,
) {
  const prod = await findMasterDoc(db, 'products', auth, { id: stokId }) as JsonObject | null;
  if (!prod) return null;

  let pelanggan: JsonObject | null = null;
  if (pelangganId) {
    pelanggan = await findMasterDoc(db, 'pelanggan', auth, { id: pelangganId }) as JsonObject | null;
    const tid = String(pelanggan?.tenantId || auth?.tenantId || 'default');
    const custom = await db.collection('customer_price_lists').findOne({
      tenantId: tid,
      pelangganId,
      stokId,
      aktif: { $ne: false },
    });
    if (Number(custom?.harga) > 0) {
      return {
        harga: Number(custom?.harga),
        hargaBeli: Number(prod.hargaBeli) || 0,
        tier: 'CUSTOM',
        source: 'customer_price_lists',
        produk: prod,
      };
    }
  }

  const tier = tierOverride || pelanggan?.tierHargaDefault || 'ECER';
  return {
    harga: priceFromProduct(prod, String(tier)),
    hargaBeli: Number(prod.hargaBeli) || 0,
    tier: String(tier).toUpperCase(),
    source: 'tier',
    produk: prod,
  };
}

interface BuildSalesLineInput {
  pelangganId?: string | null;
  stokId: string;
  qty: number | string;
  tierOverride?: string | null;
  diskon?: number | string;
}

export async function buildSalesLine(
  db: Db,
  auth: AuthContext | null,
  { pelangganId, stokId, qty, tierOverride, diskon = 0 }: BuildSalesLineInput,
) {
  const priced = await resolveUnitPrice(db, auth, { pelangganId, stokId, tierOverride });
  if (!priced) return null;
  const q = parseFloat(String(qty)) || 0;
  const d = parseInt(String(diskon || 0), 10);
  const jumlah = priced.harga * q - d;
  const p = priced.produk as JsonObject;
  return {
    lineId: uuidv4(),
    stokId: p.id,
    kode: p.kode,
    nama: p.nama,
    satuan: p.satuan,
    qtyOrdered: q,
    qtyDelivered: 0,
    qtyInvoiced: 0,
    harga: priced.harga,
    hargaBeli: priced.hargaBeli,
    diskon: d,
    jumlah,
    tier: priced.tier,
  };
}
