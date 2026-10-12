import type { JsonObject } from '@/types/json';
import { str } from '@/types/json';

const ACCEPT_MODE_LABEL: Record<string, string> = {
  AUTO_RELOCATION: 'otomatis — pindahan PO',
  AUTO_TOLERANCE: 'otomatis — dalam toleransi',
  MANUAL: 'manual',
};

/** Status persetujuan baris tambahan vendor; baris lama tanpa status dianggap menunggu. */
export function vendorLineDecisionStatus(line: JsonObject): 'PENDING' | 'ACCEPTED' | 'REJECTED' | null {
  if (line.addedFromVendorSo !== true) return null;
  const acc = line.vendorLineAcceptance as JsonObject | undefined;
  const status = str(acc?.status);
  if (status === 'ACCEPTED' || status === 'REJECTED') return status;
  return line.cancelled === true ? null : 'PENDING';
}

/** Penanda baris PO yang ditambahkan vendor / dipindah antar PO (lihat lib/api/cpo-extra-so-lines). */
export function VendorLineBadges({ line }: { line: JsonObject }) {
  const from = line.relocatedFrom as JsonObject | undefined;
  const to = line.relocatedTo as JsonObject | undefined;
  if (!line.addedFromVendorSo && !from && !to) return null;
  const acc = (line.vendorLineAcceptance as JsonObject | undefined) || {};
  const decision = vendorLineDecisionStatus(line);
  const by = str((acc.by as JsonObject | undefined)?.userName);
  return (
    <div className="mt-0.5 flex flex-wrap gap-1 no-underline">
      {line.addedFromVendorSo === true && (
        <span
          className="inline-block text-[10px] font-medium px-1 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200"
          title={`Ditambahkan vendor ${str(line.vendorTenantId)} di SO ${str(line.addedNoSO)} — tidak ada di PO awal`}
        >
          Ditambahkan vendor
        </span>
      )}
      {decision === 'PENDING' && (
        <span
          className="inline-block text-[10px] font-medium px-1 py-0.5 rounded bg-orange-100 text-orange-800 border border-orange-300"
          title={str(acc.reason) || 'Tagihan baris ini tertahan sampai purchasing menerima atau menolak'}
        >
          Menunggu persetujuan
        </span>
      )}
      {decision === 'ACCEPTED' && (
        <span
          className="inline-block text-[10px] font-medium px-1 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200"
          title={by ? `Diterima oleh ${by}` : undefined}
        >
          Diterima {ACCEPT_MODE_LABEL[str(acc.mode)] || ''}
        </span>
      )}
      {decision === 'REJECTED' && (
        <span
          className="inline-block text-[10px] font-medium px-1 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-200"
          title={by ? `Ditolak oleh ${by}` : undefined}
        >
          Ditolak purchasing
        </span>
      )}
      {line.needsMapping === true && (
        <span className="inline-block text-[10px] font-medium px-1 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-200">
          Produk belum terpetakan
        </span>
      )}
      {!!from && (
        <span className="inline-block text-[10px] font-medium px-1 py-0.5 rounded bg-sky-100 text-sky-800 border border-sky-200">
          Dipindah dari PO {str(from.noPO)}{from.vendorTenantId ? ` (${str(from.vendorTenantId)})` : ''}
        </span>
      )}
      {!!to && (
        <span className="inline-block text-[10px] font-medium px-1 py-0.5 rounded bg-sky-100 text-sky-800 border border-sky-200">
          Dipindah ke PO {str(to.noPO)}{to.vendorTenantId ? ` (${str(to.vendorTenantId)})` : ''}
        </span>
      )}
    </div>
  );
}
