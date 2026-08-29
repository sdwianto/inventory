'use client';

import type { JsonObject } from '@/types/json';
import { asArray, asObject, num, str } from '@/types/json';
import { formatDate, formatDateTime, formatIDR } from '@/lib/format';
import { DEFAULT_DELIVERY_BRAND, resolveBrandColor, darken, readableTextOn } from '@/lib/brand-color';
import { resolveInvoiceVariantFromVendor, resolveDocLogo } from '@/lib/document-variants';
import { cellBorder, densityText, effectiveBrand, headerRuleStyle, infoBoxClass, rowClass, sheetPad, tableHeadStyle, usesInfoCards } from '@/lib/document-variants/layout-style';

const APPROVAL_LABELS = {
  PENDING_REVIEW: 'Menunggu review',
  APPROVED: 'Disetujui',
  REJECTED: 'Ditolak',
  PAID_EXTERNAL: 'Lunas (luar sistem)',
};

function VarianceRow({
  label,
  value,
  delta,
  showDelta = true,
}: {
  label: string;
  value: number;
  delta?: number | null;
  showDelta?: boolean;
}) {
  const deltaColor = delta != null && delta > 0 ? 'text-red-600' : delta != null && delta < 0 ? 'text-green-600' : 'text-slate-500';
  return (
    <div className="flex justify-between text-sm py-1 border-b border-slate-100 last:border-0">
      <span className="text-slate-600">{label}</span>
      <span className="font-medium tabular-nums">
        {formatIDR(value)}
        {showDelta && delta != null && delta !== 0 && (
          <span className={`ml-2 text-xs ${deltaColor}`}>
            ({delta > 0 ? '+' : ''}{formatIDR(delta)})
          </span>
        )}
      </span>
    </div>
  );
}

function BillingLogo({ logo, alt, className = 'w-14 h-14' }: { logo?: string; alt?: string; className?: string }) {
  if (!logo) {
    return (
      <div className={`${className} rounded-lg border bg-slate-50 flex items-center justify-center shrink-0 text-slate-400 text-[10px] text-center px-1`}>
        Tanpa logo
      </div>
    );
  }
  return (
    <div className={`${className} rounded-lg border bg-white flex items-center justify-center overflow-hidden shrink-0`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logo} alt={alt} className="max-w-full max-h-full object-contain" />
    </div>
  );
}

/** Layout faktur tagihan vendor — preview layar & cetak A4. */
export default function VendorInvoiceDocument({
  detail,
  className = '',
  printId = 'vendor-invoice-a4-print',
}: {
  detail: JsonObject | null;
  className?: string;
  printId?: string;
}) {
  if (!detail) return null;

  const approval = str(detail.approvalStatus || detail.status);
  const rejectedBy = asObject(detail.rejectedBy);
  const po = asObject(detail.po);
  const vendor = asObject(detail.vendorBilling);
  const customer = asObject(detail.customerBilling);
  const billTo = str(detail.billToName || customer.companyName, '—');
  const rows = asArray(detail.itemsFull).length ? asArray(detail.itemsFull) : asArray(detail.items);
  const rowsTyped = rows as JsonObject[];
  const totals = asObject(detail.totals);
  const cmp = asObject(detail.priceComparison);
  const lineVariance = asArray(cmp.lineVarianceByUom) as JsonObject[];
  const soLineDataAvailable = cmp.soLineDataAvailable === true;
  const poStatus = str(cmp.poStatus || po.status);
  const poEst = num(cmp.poEstimasiTotal ?? detail.poEstimasiTotal ?? po.estimasiTotal);
  const soT = num(cmp.soTotal ?? detail.soTotal ?? asObject(po.vendorSoSnapshot).total);
  const invT = num(cmp.invoiceTotal ?? detail.total);
  const showCustomerLogo = customer.showLogoOnInvoice !== false;
  const variant = resolveInvoiceVariantFromVendor(vendor);
  const tokens = variant.tokens;
  const brand = effectiveBrand(resolveBrandColor(vendor, DEFAULT_DELIVERY_BRAND), tokens);
  const brandBorder = darken(brand, 0.12);
  const brandAccent = darken(brand, 0.3);
  const brandHeaderText = readableTextOn(brand);
  const th = tableHeadStyle(tokens.table, { brand, brandBorder, brandAccent, brandHeaderText });
  const cell = cellBorder(tokens.table);
  const vendorLogo = resolveDocLogo(vendor) || '';
  const metaBox = `${infoBoxClass(tokens)} text-sm`;
  const metaBoxStyle = tokens.info === 'inline' ? { borderColor: brand } : undefined;

  return (
    <article
      id={printId}
      className={`vendor-invoice-document bg-white text-slate-900 relative ${sheetPad(tokens)} ${className}`}
      style={tokens.header === 'flag' ? { paddingLeft: '6.75rem' } : undefined}
    >
      {tokens.header === 'sidebar' && (
        <div className="absolute left-0 top-0 bottom-0 w-2.5" style={{ backgroundColor: brand }} aria-hidden />
      )}
      {tokens.header === 'topBar' && (
        <div className="absolute left-0 right-0 top-0 h-2.5" style={{ backgroundColor: brand }} aria-hidden />
      )}
      {tokens.extras.watermark && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden" aria-hidden>
          <span className="select-none text-7xl font-black uppercase tracking-widest text-slate-200/60 -rotate-[28deg] whitespace-nowrap">
            {str(vendor.companyName || detail.supplierName, 'Vendor')}
          </span>
        </div>
      )}
      <div className="vendor-invoice-sheet">
      {tokens.header === 'splitMeta' ? (
      <header className="vendor-invoice-header border-b pb-2 mb-2" style={{ borderColor: brand }}>
        <div className="flex gap-3 items-start">
          <BillingLogo logo={vendorLogo} alt="Logo vendor" className="w-12 h-12" />
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-black uppercase tracking-wide leading-none">Faktur Tagihan</h1>
            <p className="font-bold text-sm mt-1">{str(vendor.companyName || detail.supplierName, 'Vendor')}</p>
            {str(vendor.companyAddress) && <p className="text-[10px] text-slate-600 leading-snug">{str(vendor.companyAddress)}</p>}
            {str(vendor.companyPhone) && <p className="text-[10px] text-slate-600">Telp: {str(vendor.companyPhone)}</p>}
          </div>
          <div className="grid grid-cols-2 gap-x-4 shrink-0 max-w-[52%] text-[11px] leading-snug">
            <div className="grid grid-cols-[auto_1fr] gap-x-1.5 gap-y-px">
              <span className="text-slate-600">No Transaksi</span><span>: {str(detail.noInvoice)}</span>
              <span className="text-slate-600">Tanggal</span><span>: {formatDateTime(str(detail.tanggal))}</span>
              <span className="text-slate-600">Tagihan kpd</span><span>: {billTo}</span>
              <span className="text-slate-600">No. Hutang</span><span>: {str(detail.noHutang)}</span>
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-1.5 gap-y-px">
              <span className="text-slate-600">No. PO</span><span>: {str(detail.noPO, '—')}</span>
              <span className="text-slate-600">No. DO</span><span>: {str(detail.noDO, '—')}</span>
              <span className="text-slate-600">Jatuh tempo</span><span>: {formatDate(str(detail.jatuhTempo))}</span>
              <span className="text-slate-600">Match</span><span>: {str(detail.matchStatus, '—')}</span>
            </div>
          </div>
        </div>
      </header>
      ) : tokens.header === 'letterhead' ? (
      <header className="vendor-invoice-header mb-3">
        <div className="flex items-center gap-2 pb-2">
          <BillingLogo logo={vendorLogo} alt="Logo vendor" className="w-11 h-11" />
          <div className="min-w-0 flex-1">
            <p className="font-bold uppercase tracking-wide text-sm">{str(vendor.companyName || detail.supplierName, 'Vendor')}</p>
            <p className="text-[10px] text-slate-500">
              {[str(vendor.companyAddress), str(vendor.companyPhone) ? `Telp. ${str(vendor.companyPhone)}` : ''].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>
        <div className="border-y-2 py-1.5 text-center" style={{ borderColor: brand }}>
          <h1 className="text-lg font-bold uppercase tracking-[0.18em]" style={{ color: brandAccent }}>Faktur Tagihan</h1>
        </div>
        <p className="text-right text-[11px] mt-1.5 font-mono">{str(detail.noInvoice)} · {formatDateTime(str(detail.tanggal))}</p>
      </header>
      ) : tokens.header === 'stackTitle' ? (
      <header className="vendor-invoice-header mb-3">
        <h1 className="text-2xl font-black uppercase tracking-tight leading-none" style={{ color: brandAccent }}>Faktur Tagihan</h1>
        <p className="text-xl font-mono font-bold mt-1">{str(detail.noInvoice)}</p>
        <p className="text-xs text-slate-500 mt-0.5">{formatDateTime(str(detail.tanggal))}</p>
        <div className="flex gap-3 items-center mt-3 pt-3 border-t">
          <BillingLogo logo={vendorLogo} alt="Logo vendor" />
          <div className="min-w-0 text-sm">
            <p className="font-bold">{str(vendor.companyName || detail.supplierName, 'Vendor')}</p>
            {str(vendor.companyAddress) && <p className="text-xs text-slate-600">{str(vendor.companyAddress)}</p>}
          </div>
        </div>
      </header>
      ) : tokens.header === 'topBar' ? (
      <header className="vendor-invoice-header flex flex-wrap gap-3 justify-between items-start pb-3 mb-3 border-b-2" style={headerRuleStyle(tokens, brand)}>
        <div className="flex gap-3 min-w-0">
          <BillingLogo logo={vendorLogo} alt="Logo vendor" />
          <div className="min-w-0 text-sm">
            <p className="font-bold text-base">{str(vendor.companyName || detail.supplierName, 'Vendor')}</p>
            {str(vendor.companyAddress) && <p className="text-xs text-slate-600">{str(vendor.companyAddress)}</p>}
          </div>
        </div>
        <div className="text-right">
          <h1 className="text-base font-bold uppercase" style={{ color: brandAccent }}>Faktur Tagihan</h1>
          <p className="text-lg font-mono font-bold">{str(detail.noInvoice)}</p>
          <p className="text-xs text-slate-600">{formatDateTime(str(detail.tanggal))}</p>
        </div>
      </header>
      ) : tokens.header === 'splitPanel' ? (
      <header className="vendor-invoice-header mb-3 grid grid-cols-[38%_1fr] min-h-[7rem] -mx-2">
        <div className="px-3 py-3 flex flex-col justify-center gap-2" style={{ backgroundColor: brand, color: brandHeaderText }}>
          <BillingLogo logo={vendorLogo} alt="Logo vendor" className="w-14 h-14" />
          <p className="font-bold leading-tight">{str(vendor.companyName || detail.supplierName, 'Vendor')}</p>
        </div>
        <div className="px-4 py-3 flex flex-col justify-center border border-l-0" style={{ borderColor: brand }}>
          <h1 className="text-xl font-bold uppercase" style={{ color: brandAccent }}>Faktur Tagihan</h1>
          <p className="text-lg font-mono font-semibold mt-1">{str(detail.noInvoice)}</p>
          <p className="text-xs text-slate-600 mt-1">{formatDateTime(str(detail.tanggal))}</p>
        </div>
      </header>
      ) : tokens.header === 'banded' ? (
      <header className="vendor-invoice-header mb-3 -mx-2">
        <div className="flex items-center gap-3 px-3 py-2" style={{ backgroundColor: brand, color: brandHeaderText }}>
          <BillingLogo logo={vendorLogo} alt="Logo vendor" className="w-12 h-12" />
          <p className="font-bold">{str(vendor.companyName || detail.supplierName, 'Vendor')}</p>
        </div>
        <div className="flex justify-between items-center px-3 py-2 border-b-2" style={{ borderColor: brand }}>
          <h1 className="text-lg font-bold uppercase" style={{ color: brandAccent }}>Faktur Tagihan</h1>
          <div className="text-right">
            <p className="font-mono font-semibold">{str(detail.noInvoice)}</p>
            <p className="text-[10px] text-slate-500">{formatDateTime(str(detail.tanggal))}</p>
          </div>
        </div>
      </header>
      ) : tokens.header === 'masthead' ? (
      <header className="vendor-invoice-header mb-3">
        <div className="flex gap-4 items-center">
          <BillingLogo logo={vendorLogo} alt="Logo vendor" className="w-20 h-20" />
          <div className="min-w-0">
            <p className="text-2xl font-black tracking-tight leading-none">{str(vendor.companyName || detail.supplierName, 'Vendor')}</p>
            {str(vendor.companyAddress) && <p className="text-xs text-slate-500 mt-1">{str(vendor.companyAddress)}</p>}
          </div>
        </div>
        <div className="flex justify-between items-end mt-3 pt-2 border-t-2" style={{ borderColor: brand }}>
          <h1 className="text-sm font-bold uppercase tracking-[0.2em]" style={{ color: brandAccent }}>Faktur Tagihan</h1>
          <div className="text-right">
            <p className="font-mono font-bold">{str(detail.noInvoice)}</p>
            <p className="text-[10px] text-slate-500">{formatDateTime(str(detail.tanggal))}</p>
          </div>
        </div>
      </header>
      ) : tokens.header === 'flag' ? (
      <>
        <div className="absolute left-0 top-0 bottom-0 w-[5.5rem] flex flex-col items-center pt-5 gap-2 px-1.5" style={{ backgroundColor: brand }} aria-hidden>
          <BillingLogo logo={vendorLogo} alt="Logo vendor" className="w-12 h-12" />
          <p className="text-[8px] font-bold text-center leading-tight uppercase" style={{ color: brandHeaderText }}>{str(vendor.companyName || detail.supplierName, 'Vendor')}</p>
        </div>
        <header className="vendor-invoice-header flex justify-between gap-4 border-b-2 pb-3 mb-3" style={headerRuleStyle(tokens, brand)}>
          <div className="min-w-0 text-sm">
            <p className="font-bold">{str(vendor.companyName || detail.supplierName, 'Vendor')}</p>
            {str(vendor.companyAddress) && <p className="text-xs text-slate-600">{str(vendor.companyAddress)}</p>}
          </div>
          <div className="text-right">
            <h1 className="text-base font-bold uppercase" style={{ color: brandAccent }}>Faktur Tagihan</h1>
            <p className="font-mono font-bold">{str(detail.noInvoice)}</p>
          </div>
        </header>
      </>
      ) : tokens.header === 'metro' ? (
      <header className="vendor-invoice-header mb-3 grid grid-cols-3 gap-3 items-stretch">
        <div className="border rounded-lg p-2 flex items-center justify-center bg-slate-50">
          <BillingLogo logo={vendorLogo} alt="Logo vendor" className="w-16 h-16" />
        </div>
        <div className="border rounded-lg p-3 flex flex-col justify-center text-sm">
          <p className="font-bold">{str(vendor.companyName || detail.supplierName, 'Vendor')}</p>
          {str(vendor.companyAddress) && <p className="text-xs text-slate-600 mt-1">{str(vendor.companyAddress)}</p>}
        </div>
        <div className="border-2 rounded-lg p-3 flex flex-col justify-center text-right" style={{ borderColor: brand }}>
          <h1 className="text-sm font-bold uppercase" style={{ color: brandAccent }}>Faktur Tagihan</h1>
          <p className="font-mono font-bold mt-1">{str(detail.noInvoice)}</p>
          <p className="text-[10px] text-slate-500 mt-1">{formatDateTime(str(detail.tanggal))}</p>
        </div>
      </header>
      ) : tokens.header === 'centered' ? (
      <header className="vendor-invoice-header text-center border-b-2 pb-3 mb-3" style={headerRuleStyle(tokens, brand)}>
        <div className="flex flex-col items-center gap-2">
          <BillingLogo logo={vendorLogo} alt="Logo vendor" />
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Penagih / Vendor</p>
          <p className="font-bold text-base leading-tight">{str(vendor.companyName || detail.supplierName, 'Vendor')}</p>
          {str(vendor.companyAddress) && <p className="text-xs text-slate-600 whitespace-pre-line">{str(vendor.companyAddress)}</p>}
          {str(vendor.companyPhone) && <p className="text-xs text-slate-500">Telp: {str(vendor.companyPhone)}</p>}
          {str(vendor.companyNPWP) && <p className="text-xs text-slate-500">NPWP: {str(vendor.companyNPWP)}</p>}
          <h1 className="text-base font-bold uppercase tracking-wide mt-1" style={{ color: brandAccent }}>Faktur Tagihan</h1>
          <p className="text-lg font-bold font-mono break-all">{str(detail.noInvoice)}</p>
          <p className="text-xs text-slate-600">{formatDateTime(str(detail.tanggal))}</p>
        </div>
      </header>
      ) : tokens.header === 'bigNumber' ? (
      <header className="vendor-invoice-header mb-3">
        <div className="flex gap-3 items-start mb-2">
          <BillingLogo logo={vendorLogo} alt="Logo vendor" />
          <div className="min-w-0 text-sm">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Penagih / Vendor</p>
            <p className="font-bold text-base leading-tight">{str(vendor.companyName || detail.supplierName, 'Vendor')}</p>
            {str(vendor.companyAddress) && <p className="text-xs text-slate-600 mt-0.5 whitespace-pre-line">{str(vendor.companyAddress)}</p>}
          </div>
        </div>
        <div className="px-3 py-2 flex items-center justify-between gap-3" style={{ backgroundColor: brand, color: brandHeaderText }}>
          <h1 className="text-sm font-bold uppercase tracking-wide">Faktur Tagihan</h1>
          <p className="text-xl font-mono font-black leading-none break-all">{str(detail.noInvoice)}</p>
        </div>
      </header>
      ) : (
      <header
        className={`vendor-invoice-header flex flex-wrap gap-3 justify-between items-start pb-3 mb-3 ${tokens.header === 'banner' ? 'px-3 py-3 -mx-2' : tokens.header === 'boxed' ? 'border-2 p-3' : 'border-b-2'}`}
        style={tokens.header === 'banner' ? { backgroundColor: brand, color: brandHeaderText } : headerRuleStyle(tokens, brand)}
      >
        <div className="flex gap-3 min-w-0">
          <BillingLogo logo={vendorLogo} alt="Logo vendor" />
          <div className="min-w-0 text-sm">
            <p className={`text-[10px] font-bold uppercase tracking-wide ${tokens.header === 'banner' ? 'opacity-80' : 'text-slate-500'}`}>Penagih / Vendor</p>
            <p className="font-bold text-base leading-tight">{str(vendor.companyName || detail.supplierName, 'Vendor')}</p>
            {str(vendor.companyAddress) && (
              <p className={`text-xs mt-0.5 whitespace-pre-line ${tokens.header === 'banner' ? 'opacity-90' : 'text-slate-600'}`}>{str(vendor.companyAddress)}</p>
            )}
            <div className={`flex flex-wrap gap-x-3 text-xs mt-1 ${tokens.header === 'banner' ? 'opacity-80' : 'text-slate-500'}`}>
              {str(vendor.companyPhone) && <span>Telp: {str(vendor.companyPhone)}</span>}
              {str(vendor.companyNPWP) && <span>NPWP: {str(vendor.companyNPWP)}</span>}
            </div>
          </div>
        </div>
        <div
          className={`text-right shrink min-w-0 max-w-[45%] ${tokens.info === 'stamp' || tokens.header === 'boxed' ? 'border-2 px-3 py-2' : ''}`}
          style={tokens.info === 'stamp' || tokens.header === 'boxed' ? { borderColor: brand } : undefined}
        >
          <h1 className="text-base font-bold uppercase tracking-wide" style={{ color: tokens.header === 'banner' ? brandHeaderText : brandAccent }}>Faktur Tagihan</h1>
          <p className={`text-lg font-bold font-mono mt-0.5 break-all ${tokens.header === 'banner' ? '' : 'text-slate-900'}`}>{str(detail.noInvoice)}</p>
          <p className={`text-xs mt-1 ${tokens.header === 'banner' ? 'opacity-90' : 'text-slate-600'}`}>{formatDateTime(str(detail.tanggal))}</p>
          <span className={`inline-block mt-2 px-2 py-0.5 rounded text-xs font-medium ${
            approval === 'APPROVED' ? 'bg-green-100 text-green-800'
              : approval === 'PENDING_REVIEW' ? 'bg-blue-100 text-blue-800'
                : approval === 'REJECTED' ? 'bg-red-100 text-red-800'
                  : 'bg-slate-100 text-slate-700'
          }`}
          >
            {APPROVAL_LABELS[approval as keyof typeof APPROVAL_LABELS] || approval}
          </span>
        </div>
      </header>
      )}

      {approval === 'REJECTED' && (
        <section className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">
          <p className="text-[10px] font-bold uppercase tracking-wide text-red-700 mb-1">Alasan penolakan</p>
          <p className="leading-snug">{str(detail.rejectReason, 'Ditolak admin')}</p>
          {(str(rejectedBy.userName) || str(detail.rejectedAt)) ? (
            <p className="text-[11px] text-red-600 mt-1.5">
              {str(rejectedBy.userName) ? `Oleh ${str(rejectedBy.userName)}` : null}
              {str(detail.rejectedAt) ? `${str(rejectedBy.userName) ? ' · ' : ''}${formatDateTime(str(detail.rejectedAt))}` : null}
            </p>
          ) : null}
        </section>
      )}

      {usesInfoCards(tokens) && (
      <section className={`vendor-invoice-meta-grid grid gap-3 mb-3 ${tokens.info === 'threeCards' ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
        <div className={metaBox} style={metaBoxStyle}>
          <div className="flex gap-3 items-start">
            {showCustomerLogo && str(customer.logoBase64) && (
              <BillingLogo logo={str(customer.logoBase64)} alt="Logo toko" className="w-12 h-12" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase text-slate-500 mb-1">Tagihan kepada</p>
              <p className="font-semibold text-sm">{billTo}</p>
              {str(customer.companyAddress) && (
                <p className="text-xs text-slate-600 mt-1 whitespace-pre-line">{str(customer.companyAddress)}</p>
              )}
              {str(customer.companyPhone) && <p className="text-xs text-slate-500 mt-1">Telp: {str(customer.companyPhone)}</p>}
              {str(customer.companyNPWP) && <p className="text-xs text-slate-500">NPWP: {str(customer.companyNPWP)}</p>}
            </div>
          </div>
        </div>
        {tokens.info === 'threeCards' ? (
          <>
            <div className={`${metaBox} text-xs space-y-1.5`} style={metaBoxStyle}>
              <p className="text-[10px] font-bold uppercase text-slate-500 mb-1">Hutang</p>
              <div><span className="text-slate-500 block">No. Hutang</span><span className="font-mono font-medium">{str(detail.noHutang)}</span></div>
              <div><span className="text-slate-500 block">Jatuh tempo</span><span className="font-medium">{formatDate(str(detail.jatuhTempo))}</span></div>
              <div><span className="text-slate-500 block">Syarat bayar</span><span>{str(detail.paymentTerms, '—')}</span></div>
            </div>
            <div className={`${metaBox} text-xs grid grid-cols-2 gap-x-3 gap-y-1.5`} style={metaBoxStyle}>
              <p className="text-[10px] font-bold uppercase text-slate-500 mb-1 col-span-2">Referensi</p>
              <div><span className="text-slate-500 block">No. PO</span><span className="font-mono">{str(detail.noPO, '—')}</span></div>
              <div><span className="text-slate-500 block">No. SO</span><span className="font-mono">{str(detail.noSO, '—')}</span></div>
              <div><span className="text-slate-500 block">No. DO</span><span className="font-mono">{str(detail.noDO, '—')}</span></div>
              <div><span className="text-slate-500 block">Match GRN</span><span>{str(detail.matchStatus, '—')}</span></div>
              <div>
                <span className="text-slate-500 block">Minta kedatangan</span>
                <span className="font-medium">
                  {str(detail.tanggalPermintaanKirim || asObject(detail.po).tanggalKedatangan)
                    ? formatDate(str(detail.tanggalPermintaanKirim || asObject(detail.po).tanggalKedatangan))
                    : '—'}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block">Aktual kirim</span>
                <span className="font-medium">
                  {str(detail.tanggalAktualKirim || detail.shippedAt || detail.tanggal)
                    ? formatDate(str(detail.tanggalAktualKirim || detail.shippedAt || detail.tanggal))
                    : '—'}
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className={`${metaBox} text-xs grid grid-cols-2 gap-x-3 gap-y-1.5`} style={metaBoxStyle}>
            <div><span className="text-slate-500 block">No. Hutang</span><span className="font-mono font-medium">{str(detail.noHutang)}</span></div>
            <div><span className="text-slate-500 block">Jatuh tempo</span><span className="font-medium">{formatDate(str(detail.jatuhTempo))}</span></div>
            <div><span className="text-slate-500 block">No. PO</span><span className="font-mono">{str(detail.noPO, '—')}</span></div>
            <div><span className="text-slate-500 block">No. SO</span><span className="font-mono">{str(detail.noSO, '—')}</span></div>
            <div><span className="text-slate-500 block">No. DO</span><span className="font-mono">{str(detail.noDO, '—')}</span></div>
            <div><span className="text-slate-500 block">Syarat bayar</span><span>{str(detail.paymentTerms, '—')}</span></div>
            <div>
              <span className="text-slate-500 block" title="Tanggal permintaan kedatangan barang dari PO">Minta kedatangan</span>
              <span className="font-medium">
                {str(detail.tanggalPermintaanKirim || asObject(detail.po).tanggalKedatangan)
                  ? formatDate(str(detail.tanggalPermintaanKirim || asObject(detail.po).tanggalKedatangan))
                  : '—'}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block" title="Tanggal aktual kirim / penerimaan">Aktual kirim</span>
              <span className="font-medium">
                {str(detail.tanggalAktualKirim || detail.shippedAt || detail.tanggal)
                  ? formatDate(str(detail.tanggalAktualKirim || detail.shippedAt || detail.tanggal))
                  : '—'}
              </span>
            </div>
            <div><span className="text-slate-500 block">Status PO</span><span>{str(po.status, '—')}</span></div>
            <div><span className="text-slate-500 block">Match GRN</span><span>{str(detail.matchStatus, '—')}</span></div>
          </div>
        )}
      </section>
      )}

      <table className={`vendor-invoice-items-table w-full ${densityText(tokens)} border-collapse ${tokens.table === 'hairline' ? 'mb-2' : 'mb-4'}`}>
        <colgroup>
          <col className="vi-col-no" />
          <col className="vi-col-kode" />
          <col className="vi-col-nama" />
          {tokens.extras.qtyWithUnit ? (
            <col className="vi-col-qty" />
          ) : (
            <>
              <col className="vi-col-sat" />
              <col className="vi-col-qty" />
            </>
          )}
          <col className="vi-col-harga" />
          <col className="vi-col-diskon" />
          <col className="vi-col-jumlah" />
        </colgroup>
        <thead>
          <tr style={th}>
            <th className={`${cell} px-1.5 py-1 text-center`}>#</th>
            <th className={`${cell} px-1.5 py-1 text-left`}>Kode</th>
            <th className={`${cell} px-1.5 py-1 text-left`}>Nama Barang</th>
            {tokens.extras.qtyWithUnit ? (
              <th className={`${cell} px-1.5 py-1 text-left`}>Jml Satuan</th>
            ) : (
              <>
                <th className={`${cell} px-1.5 py-1 text-center`}>Sat</th>
                <th className={`${cell} px-1.5 py-1 text-right`}>Qty</th>
              </>
            )}
            <th className={`${cell} px-1.5 py-1 text-right`}>Harga</th>
            <th className={`${cell} px-1.5 py-1 text-right`}>{tokens.extras.qtyWithUnit ? 'Pot' : 'Diskon'}</th>
            <th className={`${cell} px-1.5 py-1 text-right`}>Jumlah</th>
          </tr>
        </thead>
        <tbody>
          {rowsTyped.map((it, i) => (
            <tr key={str(it.lineNo, String(i))} className={rowClass(tokens.table, i)}>
              <td className={`${cell} px-1.5 py-1 text-center text-slate-500`}>{str(it.lineNo, String(i + 1))}</td>
              <td className={`${cell} px-1.5 py-1 font-mono text-[10px] break-all`}>{str(it.kode)}</td>
              <td className={`${cell} px-1.5 py-1 break-words`}>{str(it.nama, '—')}</td>
              {tokens.extras.qtyWithUnit ? (
                <td className={`${cell} px-1.5 py-1`}>{num(it.qty)} {str(it.satuan)}</td>
              ) : (
                <>
                  <td className={`${cell} px-1.5 py-1 text-center`}>{str(it.satuan, '—')}</td>
                  <td className={`${cell} px-1.5 py-1 text-right tabular-nums`}>{num(it.qty)}</td>
                </>
              )}
              <td className={`${cell} px-1.5 py-1 text-right tabular-nums vi-money`}>{formatIDR(num(it.harga))}</td>
              <td className={`${cell} px-1.5 py-1 text-right tabular-nums vi-money`}>{num(it.diskon) ? formatIDR(num(it.diskon)) : '—'}</td>
              <td className={`${cell} px-1.5 py-1 text-right tabular-nums font-medium vi-money`}>
                {formatIDR(num(it.jumlah, num(it.qty) * num(it.harga)))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tokens.table === 'hairline' && <div className="border-t mb-2" style={{ borderColor: brand }} />}

      {tokens.extras.footerTrio ? (
      <section className="grid grid-cols-3 gap-3 border-t border-slate-800 pt-2 mt-2 text-[11px] leading-snug">
        <div className="min-w-0">
          <div>Keterangan: {str(detail.catatan, '—')}</div>
          <div className={`flex gap-4 text-center mt-3 ${tokens.signatures === 3 ? '' : ''}`}>
            {(tokens.signatures === 3 ? ['Vendor', 'Penerima', 'Mengetahui'] : ['Hormat Kami', 'Penerima']).map((label) => (
              <div key={label} className="flex-1 min-w-0">
                <div className="mb-10">{label}</div>
                <div className="border-b border-dotted border-slate-500 text-[10px] text-slate-400">(..........)</div>
              </div>
            ))}
          </div>
        </div>
        <div className="min-w-0 space-y-1">
          <div>Jatuh tempo : {formatDate(str(detail.jatuhTempo))}</div>
          <div>No. PO : {str(detail.noPO, '—')}</div>
          <div>Estimasi PO : {formatIDR(poEst)}</div>
          <div>Nilai SO : {formatIDR(soT)}</div>
        </div>
        <div className="min-w-0 grid grid-cols-[auto_1fr] gap-x-2 gap-y-px">
          <span className="text-slate-500">Sub Total</span>
          <span className="text-right tabular-nums">{formatIDR(num(totals.subTotal ?? detail.subTotal))}</span>
          <span className="text-slate-500">PPN</span>
          <span className="text-right tabular-nums">{formatIDR(num(totals.ppn ?? detail.ppn))}</span>
          <span className="font-bold border-t pt-0.5 mt-0.5">Total Akhir</span>
          <span className="font-bold text-right tabular-nums border-t pt-0.5 mt-0.5">{formatIDR(num(totals.total ?? detail.total))}</span>
        </div>
      </section>
      ) : (
      <section className="vendor-invoice-footer-grid grid sm:grid-cols-2 gap-3">
        <div className="border rounded-lg p-3 bg-slate-50">
          <p className="font-medium text-sm mb-2">Perbandingan harga</p>
          <VarianceRow label="Estimasi PO" value={poEst} showDelta={false} />
          <VarianceRow label="Nilai SO (sales.app)" value={soT} delta={soT && poEst ? soT - poEst : null} showDelta={!!soT} />
          <VarianceRow label="Invoice (aktual)" value={invT} delta={soT ? invT - soT : null} showDelta={!!soT} />
          {lineVariance.length > 0 && (() => {
            const fmtDelta = (v: number | null) => {
              if (v == null || v === 0) return '—';
              return v > 0 ? `+${v}` : String(v);
            };
            const qtyRows = lineVariance
              .map((row) => {
                const soMissing = row.soLineMissing === true
                  || (!soLineDataAvailable && num(row.soQty) === 0 && num(row.poQty) > 0);
                const invMissing = row.invLineMissing === true;
                const dSo = row.variancePoToSo == null ? null : num(row.variancePoToSo);
                const dInv = row.varianceSoToInvoice == null ? null : num(row.varianceSoToInvoice);
                return {
                  row,
                  dSo,
                  dInv,
                  soQty: num(row.soQty),
                  poQty: num(row.poQty),
                  invQty: num(row.invoiceQty),
                  soMissing,
                  invMissing,
                };
              })
              .filter(({ dSo, dInv, poQty, invQty, soMissing, invMissing }) => {
                if (soMissing || invMissing) return poQty !== invQty || soMissing;
                return dSo !== 0 || dInv !== 0;
              });
            if (!qtyRows.length) return null;
            const hasQtyMismatch = qtyRows.some(({ dSo, dInv, soMissing }) => (
              !soMissing && ((dSo != null && dSo !== 0) || (dInv != null && dInv !== 0))
            ));
            const hasMissingSo = qtyRows.some(({ soMissing }) => soMissing);
            return (
            <div className="mt-3 pt-2 border-t border-slate-200">
              <p className="text-[10px] font-bold uppercase text-slate-500 mb-0.5">Selisih qty per barang</p>
              <p className="text-[9px] text-slate-400 mb-1.5 leading-snug">
                PO (inventory) → SO (snapshot sales.app) → Inv (faktur vendor).
                {hasMissingSo
                  ? ' SO “—” = baris tidak ada di snapshot SO (bukan qty 0). Δ Inv memakai Inv − PO bila SO tidak ada.'
                  : hasQtyMismatch
                    ? ' Baris kuning = qty berbeda antar tahap.'
                    : ''}
                {poStatus && poStatus !== 'CONFIRMED' && poStatus !== 'INVOICED' && poStatus !== 'RECEIVED'
                  ? ` Status PO: ${poStatus}.`
                  : ''}
              </p>
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="text-slate-500">
                    <th className="text-left py-0.5">Kode</th>
                    <th className="text-center py-0.5">Sat</th>
                    <th className="text-right py-0.5" title="Qty di PO customer">PO</th>
                    <th className="text-right py-0.5" title="Qty di snapshot SO sales.app">SO</th>
                    <th className="text-right py-0.5" title="Qty di faktur vendor">Inv</th>
                    <th className="text-right py-0.5" title="SO − PO">Δ SO</th>
                    <th className="text-right py-0.5" title="Inv − SO (atau Inv − PO jika SO tidak ada)">Δ Inv</th>
                  </tr>
                </thead>
                <tbody>
                  {qtyRows.map(({ row, dSo, dInv, soQty, invQty, soMissing, invMissing }, i) => {
                    const warn = !soMissing && ((dSo != null && dSo !== 0) || (dInv != null && dInv !== 0));
                    return (
                      <tr
                        key={`${str(row.kode)}-${str(row.satuan)}-${i}`}
                        className={soMissing ? 'text-slate-500 bg-slate-100/80' : warn ? 'text-amber-800 bg-amber-50/60' : ''}
                      >
                        <td className="font-mono py-0.5">{str(row.kode)}</td>
                        <td className="text-center py-0.5">{str(row.satuan)}</td>
                        <td className="text-right tabular-nums py-0.5">{num(row.poQty)}</td>
                        <td className="text-right tabular-nums py-0.5">{soMissing ? '—' : soQty}</td>
                        <td className="text-right tabular-nums py-0.5">{invMissing ? '—' : invQty}</td>
                        <td className="text-right tabular-nums py-0.5 font-medium">{fmtDelta(dSo)}</td>
                        <td className="text-right tabular-nums py-0.5 font-medium">{fmtDelta(dInv)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            );
          })()}
        </div>
        <div className={`border rounded-lg p-3 space-y-1 min-w-0 vendor-invoice-totals ${tokens.extras.taxEmphasis ? 'border-2' : ''}`} style={tokens.extras.taxEmphasis ? { borderColor: brand } : undefined}>
          {tokens.extras.taxEmphasis && (
            <div className="text-[10px] font-bold uppercase text-slate-500 mb-1">Rincian pajak</div>
          )}
          <div className="flex justify-between text-xs">
            <span className="text-slate-500">Subtotal barang</span>
            <span className="tabular-nums">{formatIDR(num(totals.itemsSubTotal ?? detail.subTotal))}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-slate-500">DPP / Subtotal</span>
            <span className="tabular-nums">{formatIDR(num(totals.subTotal ?? detail.subTotal))}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-slate-500">PPN</span>
            <span className="tabular-nums">{formatIDR(num(totals.ppn ?? detail.ppn))}</span>
          </div>
          <div className="flex justify-between font-bold text-base pt-2 border-t mt-2">
            <span>Total tagihan</span>
            <span className="tabular-nums" style={{ color: brandAccent }}>{formatIDR(num(totals.total ?? detail.total))}</span>
          </div>
        </div>
      </section>
      <section className={`grid gap-8 text-center text-sm mt-8 mb-4 ${tokens.signatures === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {(tokens.signatures === 3 ? ['Vendor', 'Penerima', 'Mengetahui'] : ['Vendor', 'Penerima']).map((label) => (
          <div key={label}>
            <div className="font-medium mb-16">{label}</div>
            <div className="border-t border-slate-400 pt-1 text-[10px] text-slate-500">( tanda tangan &amp; cap )</div>
          </div>
        ))}
      </section>
      )}
      {tokens.extras.complaintNote && (
        <p className="text-center text-[9px] text-slate-600 mt-3 leading-snug">
          Kami hanya melayani komplain barang paling lambat H+1 setelah barang diterima oleh Customer
        </p>
      )}
      </div>
    </article>
  );
}
