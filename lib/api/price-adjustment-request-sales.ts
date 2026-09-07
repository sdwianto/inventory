/** ADR-008 — minta Sales buat draft CN koreksi harga (finansial, bukan RTV). */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { resolveEffectiveSalesAppUrl } from '@/lib/api/sales-app-url';
import { createIntegrationClient } from '@/lib/integration/client';
import { IntegrationError } from '@/lib/integration/errors';
import { integrationCorrelationId } from '@/lib/api/integration-common';
import { normalizeTenantId } from '@/lib/api/tenant-scope';

export type PriceAdjustmentLineInput = {
  lineId: string;
  qty: number;
  /** Harga yang seharusnya (benar). Selisih = max(0, hargaInvoice − hargaBenar). */
  hargaBenar: number;
  reason?: string;
};

export async function requestPriceAdjustmentCnFromSales(
  db: Db,
  tenantId: string,
  hutang: {
    id: string;
    vendorTenantId?: string;
    vendorInvoiceId?: string;
    noInvoice?: string;
    items?: Array<{
      lineId?: string;
      stokId?: string;
      kode?: string;
      nama?: string;
      satuan?: string;
      uomId?: string;
      qty?: number | string;
      harga?: number | string;
    }>;
  },
  lines: PriceAdjustmentLineInput[],
  catatan?: string,
): Promise<{
  ok: boolean;
  skipped?: boolean;
  error?: string;
  status?: number;
  claimId?: string;
  creditNoteId?: string;
  noCN?: string;
  amount?: number;
  cnStatus?: string;
  created?: boolean;
}> {
  const tid = normalizeTenantId(tenantId);
  const vendorTenantId = String(hutang.vendorTenantId || '').trim();
  const apiKey = await getSalesApiKeyForVendor(db, tid, vendorTenantId || undefined);
  const salesAppUrl = resolveEffectiveSalesAppUrl();
  if (!apiKey || !salesAppUrl) {
    return {
      ok: false,
      skipped: true,
      error: 'Integrasi Sales belum dikonfigurasi (API key / SALES_APP_URL)',
      status: 503,
    };
  }

  const hutangItems = hutang.items || [];
  const cnItems: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    const lineId = String(line.lineId || '').trim();
    const invLine = hutangItems.find((it) => String(it.lineId || '') === lineId);
    if (!invLine) {
      return { ok: false, error: `Baris hutang tidak ditemukan: ${lineId}`, status: 400 };
    }
    const hargaInvoice = parseInt(String(invLine.harga || 0), 10) || 0;
    const hargaBenar = Math.max(0, Math.round(Number(line.hargaBenar) || 0));
    const delta = hargaInvoice - hargaBenar;
    if (delta < 0) {
      return {
        ok: false,
        error: `Baris ${invLine.kode || lineId}: harga benar (${hargaBenar}) > tagihan (${hargaInvoice}) = undercharge. Gunakan Debit Note (Koreksi harga DN), bukan Credit Note.`,
        status: 400,
      };
    }
    if (delta === 0) {
      return {
        ok: false,
        error: `Baris ${invLine.kode || lineId}: harga benar sama dengan tagihan — tidak ada koreksi`,
        status: 400,
      };
    }
    const qtyMax = parseFloat(String(invLine.qty || 0)) || 0;
    const qty = Math.min(qtyMax, Math.max(0, parseFloat(String(line.qty)) || 0));
    if (qty <= 0) {
      return { ok: false, error: `Baris ${invLine.kode || lineId}: qty koreksi harus > 0`, status: 400 };
    }
    cnItems.push({
      lineId,
      stokId: String(invLine.stokId || ''),
      kode: invLine.kode,
      nama: invLine.nama,
      satuan: invLine.satuan,
      uomId: invLine.uomId,
      qty,
      harga: delta,
      reason: line.reason || `Koreksi harga: tagihan ${hargaInvoice} → benar ${hargaBenar}`,
    });
  }
  if (!cnItems.length) {
    return { ok: false, error: 'Pilih minimal satu baris untuk dikoreksi', status: 400 };
  }

  const claimId = uuidv4();
  const client = createIntegrationClient(db);
  try {
    const result = await client.postPriceAdjustmentCn({
      salesAppUrl,
      apiKey,
      claimId,
      idempotencyKey: claimId,
      correlationId: integrationCorrelationId(`price-adj:${hutang.id}:${claimId}`),
      body: {
        customerTenantId: tid,
        vendorTenantId,
        claimId,
        hutangId: hutang.id,
        invoiceId: hutang.vendorInvoiceId || '',
        noInvoice: hutang.noInvoice || '',
        catatan: catatan || `Koreksi harga dari Inventory — ${hutang.noInvoice || hutang.id}`,
        items: cnItems,
      },
    });

    const trail = {
      claimId,
      creditNoteId: result.creditNoteId,
      noCN: result.noCN,
      amount: result.amount,
      status: result.status,
      source: 'price_adjustment',
      createdAt: new Date(),
      items: cnItems.map((it) => ({
        lineId: it.lineId,
        qty: it.qty,
        harga: it.harga,
        kode: it.kode,
      })),
    };

    await db.collection('hutang').updateOne(
      { id: hutang.id, tenantId: tid },
      {
        $push: { priceAdjustmentClaims: trail } as never,
        $set: { updatedAt: new Date() },
      },
    );

    return {
      ok: true,
      claimId,
      creditNoteId: result.creditNoteId,
      noCN: result.noCN,
      amount: result.amount,
      cnStatus: result.status,
      created: result.created,
    };
  } catch (e) {
    const msg = e instanceof IntegrationError
      ? e.message
      : (e instanceof Error ? e.message : String(e));
    const status = e instanceof IntegrationError ? (e.httpStatus || 502) : 502;
    return { ok: false, error: msg, status, claimId };
  }
}

/** ADR-008 — minta Sales buat draft DN koreksi undercharge (finansial, bukan RTV). */
export async function requestPriceAdjustmentDnFromSales(
  db: Db,
  tenantId: string,
  hutang: {
    id: string;
    vendorTenantId?: string;
    vendorInvoiceId?: string;
    noInvoice?: string;
    items?: Array<{
      lineId?: string;
      stokId?: string;
      kode?: string;
      nama?: string;
      satuan?: string;
      uomId?: string;
      qty?: number | string;
      harga?: number | string;
    }>;
  },
  lines: PriceAdjustmentLineInput[],
  catatan?: string,
): Promise<{
  ok: boolean;
  skipped?: boolean;
  error?: string;
  status?: number;
  claimId?: string;
  debitNoteId?: string;
  noDN?: string;
  amount?: number;
  dnStatus?: string;
  created?: boolean;
}> {
  const tid = normalizeTenantId(tenantId);
  const vendorTenantId = String(hutang.vendorTenantId || '').trim();
  const apiKey = await getSalesApiKeyForVendor(db, tid, vendorTenantId || undefined);
  const salesAppUrl = resolveEffectiveSalesAppUrl();
  if (!apiKey || !salesAppUrl) {
    return {
      ok: false,
      skipped: true,
      error: 'Integrasi Sales belum dikonfigurasi (API key / SALES_APP_URL)',
      status: 503,
    };
  }

  const hutangItems = hutang.items || [];
  const dnItems: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    const lineId = String(line.lineId || '').trim();
    const invLine = hutangItems.find((it) => String(it.lineId || '') === lineId);
    if (!invLine) {
      return { ok: false, error: `Baris hutang tidak ditemukan: ${lineId}`, status: 400 };
    }
    const hargaInvoice = parseInt(String(invLine.harga || 0), 10) || 0;
    const hargaBenar = Math.max(0, Math.round(Number(line.hargaBenar) || 0));
    const delta = hargaBenar - hargaInvoice;
    if (delta < 0) {
      return {
        ok: false,
        error: `Baris ${invLine.kode || lineId}: harga benar (${hargaBenar}) < tagihan (${hargaInvoice}) = overcharge. Gunakan Credit Note (Koreksi harga CN), bukan Debit Note.`,
        status: 400,
      };
    }
    if (delta === 0) {
      return {
        ok: false,
        error: `Baris ${invLine.kode || lineId}: harga benar sama dengan tagihan — tidak ada koreksi`,
        status: 400,
      };
    }
    const qtyMax = parseFloat(String(invLine.qty || 0)) || 0;
    const qty = Math.min(qtyMax, Math.max(0, parseFloat(String(line.qty)) || 0));
    if (qty <= 0) {
      return { ok: false, error: `Baris ${invLine.kode || lineId}: qty koreksi harus > 0`, status: 400 };
    }
    dnItems.push({
      lineId,
      stokId: String(invLine.stokId || ''),
      kode: invLine.kode,
      nama: invLine.nama,
      satuan: invLine.satuan,
      uomId: invLine.uomId,
      qty,
      harga: delta,
      reason: line.reason || `Koreksi undercharge: tagihan ${hargaInvoice} → benar ${hargaBenar}`,
    });
  }
  if (!dnItems.length) {
    return { ok: false, error: 'Pilih minimal satu baris undercharge untuk dikoreksi', status: 400 };
  }

  const claimId = uuidv4();
  const client = createIntegrationClient(db);
  try {
    const result = await client.postPriceAdjustmentDn({
      salesAppUrl,
      apiKey,
      claimId,
      idempotencyKey: claimId,
      correlationId: integrationCorrelationId(`price-adj-dn:${hutang.id}:${claimId}`),
      body: {
        customerTenantId: tid,
        vendorTenantId,
        claimId,
        hutangId: hutang.id,
        invoiceId: hutang.vendorInvoiceId || '',
        noInvoice: hutang.noInvoice || '',
        catatan: catatan || `Koreksi undercharge dari Inventory — ${hutang.noInvoice || hutang.id}`,
        items: dnItems,
      },
    });

    const trail = {
      claimId,
      debitNoteId: result.debitNoteId,
      noDN: result.noDN,
      amount: result.amount,
      status: result.status,
      source: 'price_adjustment',
      kind: 'dn',
      createdAt: new Date(),
      items: dnItems.map((it) => ({
        lineId: it.lineId,
        qty: it.qty,
        harga: it.harga,
        kode: it.kode,
      })),
    };

    await db.collection('hutang').updateOne(
      { id: hutang.id, tenantId: tid },
      {
        $push: { priceAdjustmentDnClaims: trail } as never,
        $set: { updatedAt: new Date() },
      },
    );

    return {
      ok: true,
      claimId,
      debitNoteId: result.debitNoteId,
      noDN: result.noDN,
      amount: result.amount,
      dnStatus: result.status,
      created: result.created,
    };
  } catch (e) {
    const msg = e instanceof IntegrationError
      ? e.message
      : (e instanceof Error ? e.message : String(e));
    const status = e instanceof IntegrationError ? (e.httpStatus || 502) : 502;
    return { ok: false, error: msg, status, claimId };
  }
}
