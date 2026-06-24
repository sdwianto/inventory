// Resolusi harga jual: harga khusus pelanggan → tier pelanggan → tier manual.

import { v4 as uuidv4 } from 'uuid';
import { findMasterDoc } from '@/lib/api/tenant-master';

const TIER_FIELDS = {
  ECER: 'hargaEcer',
  GROSIR: 'hargaGrosir',
  SPESIAL: 'hargaSpesial',
};

export function tierField(tier) {
  return TIER_FIELDS[String(tier || 'ECER').toUpperCase()] || 'hargaEcer';
}

export function priceFromProduct(prod, tier) {
  const field = tierField(tier);
  return prod?.[field] ?? prod?.hargaEcer ?? 0;
}

export async function resolveUnitPrice(db, auth, { pelangganId, stokId, tierOverride }) {
  const prod = await findMasterDoc(db, 'products', auth, { id: stokId });
  if (!prod) return null;

  let pelanggan = null;
  if (pelangganId) {
    pelanggan = await findMasterDoc(db, 'pelanggan', auth, { id: pelangganId });
    const tid = pelanggan?.tenantId || auth?.tenantId || 'default';
    const custom = await db.collection('customer_price_lists').findOne({
      tenantId: tid,
      pelangganId,
      stokId,
      aktif: { $ne: false },
    });
    if (custom?.harga > 0) {
      return {
        harga: custom.harga,
        hargaBeli: prod.hargaBeli || 0,
        tier: 'CUSTOM',
        source: 'customer_price_lists',
        produk: prod,
      };
    }
  }

  const tier = tierOverride || pelanggan?.tierHargaDefault || 'ECER';
  return {
    harga: priceFromProduct(prod, tier),
    hargaBeli: prod.hargaBeli || 0,
    tier: String(tier).toUpperCase(),
    source: 'tier',
    produk: prod,
  };
}

export async function buildSalesLine(db, auth, { pelangganId, stokId, qty, tierOverride, diskon = 0 }) {
  const priced = await resolveUnitPrice(db, auth, { pelangganId, stokId, tierOverride });
  if (!priced) return null;
  const q = parseFloat(qty) || 0;
  const d = parseInt(diskon || 0, 10);
  const jumlah = priced.harga * q - d;
  const p = priced.produk;
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
