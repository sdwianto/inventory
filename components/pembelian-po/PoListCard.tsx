'use client';

import { useState } from 'react';
import type { JsonObject } from '@/types/json';
import { str, num, asObject, asArray } from '@/types/json';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  CheckCircle2, ChevronDown, ChevronRight, CopyPlus, Pencil, Printer, RefreshCw, Send, Trash2, XCircle,
} from 'lucide-react';
import { formatDate, formatDateTime, formatIDR, formatNumber } from '@/lib/format';
import { getPoArrivalDate, PO_STATUS_STYLE } from '@/lib/po-calendar';
import { poCreatorLabel, formatPoVendorSoDisplay, isPendingOptimisticPo } from '@/lib/pembelian-po/helpers';
import { canRequestApprovalPoStatus } from '@/lib/pembelian-po/permissions';
import { canReviseCancelledPoStatus } from '@/lib/pembelian-po/revise-from-cancelled';
import PrintPortal from '@/components/PrintPortal';
import CustomerPoDocument from '@/components/CustomerPoDocument';
import { printDocument } from '@/lib/doc-print';

const PO_PRINT_ID = 'customer-po-a4-print';

export type PoListCardProps = {
  po: JsonObject;
  expanded: boolean;
  onToggleExpand: () => void;
  vendorNameById: Record<string, string>;
  canEdit: boolean;
  canRequest: boolean;
  canDirectSubmit: boolean;
  canApprove: boolean;
  user: JsonObject | null;
  submitting: string;
  onEdit: () => void;
  onRequestApproval: () => void;
  onSubmit: () => void;
  onSyncVendor: () => void;
  onSyncVendorForVendor?: (vendorTenantId: string) => void;
  onSyncSoLines?: () => void;
  onApprove: () => void;
  onReject: (reason: string) => void;
  onDeleteDraft?: () => void;
  onRevise?: () => void;
  canRevise?: boolean;
  tenantName?: string;
};

export default function PoListCard({
  po,
  expanded,
  onToggleExpand,
  vendorNameById,
  canEdit,
  canRequest,
  canDirectSubmit,
  canApprove,
  user,
  submitting,
  onEdit,
  onRequestApproval,
  onSubmit,
  onSyncVendor,
  onSyncVendorForVendor,
  onSyncSoLines,
  onApprove,
  onReject,
  onDeleteDraft,
  onRevise,
  canRevise = false,
  tenantName,
}: PoListCardProps) {
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [reviseDialogOpen, setReviseDialogOpen] = useState(false);
  const [printing, setPrinting] = useState(false);

  const poId = str(po.id);
  const isOptimistic = isPendingOptimisticPo(po);
  const arrival = getPoArrivalDate(po);
  const poStatus = str(po.status);
  const vendorSoLabel = formatPoVendorSoDisplay(po, vendorNameById);
  const createdBy = asObject(po.createdBy);
  const approvedBy = asObject(po.approvedBy);
  const lastEditedBy = asObject(po.lastEditedBy);
  const poItems = asArray(po.items) as JsonObject[];
  const vendorSubs = asArray(po.vendorSubmissions) as JsonObject[];
  const cancelledSoLines = asArray(po.cancelledSoLines) as JsonObject[];
  const failedVendors = vendorSubs.filter((s) => str(s.status) === 'FAILED');
  const isSubmitting = submitting === poId || submitting.startsWith(`${poId}:`);

  const handleReject = () => {
    onReject(rejectReason || 'Ditolak admin');
    setRejectDialogOpen(false);
    setRejectReason('');
  };

  const handlePrint = async () => {
    setPrinting(true);
    try {
      await printDocument(PO_PRINT_ID);
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div id={`cpo-row-${poId}`} className="border rounded-lg overflow-hidden scroll-mt-24">
      <div className="flex items-center gap-2 px-3 py-2.5 hover:bg-slate-50">
        <button
          type="button"
          className="flex flex-1 items-center gap-2 min-w-0 text-left"
          onClick={onToggleExpand}
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4 shrink-0 text-slate-400" />
          ) : (
            <ChevronRight className="w-4 h-4 shrink-0 text-slate-400" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs font-semibold">{str(po.noPO)}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${PO_STATUS_STYLE[poStatus as keyof typeof PO_STATUS_STYLE] || PO_STATUS_STYLE.DRAFT}`}>
                {isOptimistic ? 'MENYIMPAN' : poStatus}
              </span>
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Kedatangan: {formatDate(arrival)} · Dibuat: {formatDateTime(str(po.tanggal))}
              {poCreatorLabel(po) !== 'Tidak tercatat' && ` · oleh ${poCreatorLabel(po)}`}
              {!!vendorSoLabel && (
                <span className="block sm:inline sm:before:content-['·_'] sm:before:mx-1 mt-0.5 sm:mt-0">
                  SO vendor: {vendorSoLabel}
                </span>
              )}
              {!vendorSoLabel && poStatus === 'APPROVED' && !!po.vendorSyncError && !isOptimistic && (
                <span className="block sm:inline sm:before:content-['·_'] sm:before:mx-1 mt-0.5 sm:mt-0 text-red-700">
                  Gagal kirim ke vendor
                </span>
              )}
              {!vendorSoLabel && poStatus === 'APPROVED' && !!po.vendorSyncPending && !po.vendorSyncError && isOptimistic && (
                <span className="block sm:inline sm:before:content-['·_'] sm:before:mx-1 mt-0.5 sm:mt-0 text-blue-700">
                  Mengirim ke vendor…
                </span>
              )}
              {!vendorSoLabel && ['SUBMITTED', 'CONFIRMED', 'PARTIAL_CANCELLED', 'PARTIAL_SHIPPED', 'SHIPPED'].includes(poStatus) && !isOptimistic && (
                <span className="block sm:inline sm:before:content-['·_'] sm:before:mx-1 mt-0.5 sm:mt-0 text-amber-700">
                  Nomor SO belum tersinkron — refresh halaman atau klik Sync SO
                </span>
              )}
            </div>
          </div>
        </button>
        {onSyncSoLines && !isOptimistic && ['SUBMITTED', 'CONFIRMED', 'PARTIAL_CANCELLED', 'PARTIAL_SHIPPED', 'SHIPPED', 'PARTIAL_RECEIVED', 'RECEIVED', 'INVOICED'].includes(poStatus) && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 border-slate-300 text-slate-700 hover:bg-slate-50"
            onClick={onSyncSoLines}
            disabled={isSubmitting}
            title="Tarik status cancel baris dari SO sales.app"
          >
            <RefreshCw className={`w-3 h-3 mr-1 ${isSubmitting ? 'animate-spin' : ''}`} />
            Sync SO
          </Button>
        )}
        {canEdit && !isOptimistic && (
          <Button size="sm" variant="outline" className="shrink-0" onClick={onEdit}>
            <Pencil className="w-3 h-3 mr-1" />
            Edit
          </Button>
        )}
        {canRevise && onRevise && !isOptimistic && canReviseCancelledPoStatus(poStatus) && !po.supersededByPoId && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 border-orange-300 text-orange-800 hover:bg-orange-50"
            onClick={() => setReviseDialogOpen(true)}
            disabled={isSubmitting}
            title="Buat draft baru dengan nomor PO baru — history lama tetap ada"
          >
            <CopyPlus className={`w-3 h-3 mr-1 ${isSubmitting ? 'animate-pulse' : ''}`} />
            Buat ulang
          </Button>
        )}
        {poStatus === 'DRAFT' && canEdit && !isOptimistic && onDeleteDraft && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
            onClick={() => setDeleteDialogOpen(true)}
            disabled={isSubmitting}
            title="Hapus PO draft"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        )}
        {(canRequestApprovalPoStatus(poStatus)) && canRequest && !isOptimistic && (
          user?.role !== 'GUDANG' || str(createdBy.userId) === str(user?.id)
        ) && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={onRequestApproval}
            disabled={isSubmitting}
          >
            <Send className="w-3 h-3 mr-1" />
            {isSubmitting ? '...' : poStatus === 'REJECTED' ? 'Ajukan ulang' : 'Ajukan'}
          </Button>
        )}
        {poStatus === 'DRAFT' && canDirectSubmit && !isOptimistic && (
          <Button size="sm" className="shrink-0" onClick={onSubmit} disabled={isSubmitting}>
            <Send className="w-3 h-3 mr-1" />
            {isSubmitting ? '...' : 'Kirim'}
          </Button>
        )}
        {poStatus === 'APPROVED' && canApprove && !vendorSoLabel && (!!po.vendorSyncError || !!po.vendorSyncPending) && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 border-emerald-300 text-emerald-800 hover:bg-emerald-50"
            onClick={onSyncVendor}
            disabled={isSubmitting}
          >
            <RefreshCw className={`w-3 h-3 mr-1 ${isSubmitting ? 'animate-spin' : ''}`} />
            {isSubmitting ? '...' : 'Kirim ke vendor'}
          </Button>
        )}
        {poStatus === 'PENDING_APPROVAL' && canApprove && (
          <>
            <Button
              size="sm"
              className="shrink-0 bg-green-600 hover:bg-green-700"
              onClick={onApprove}
              disabled={isSubmitting}
            >
              <CheckCircle2 className="w-3 h-3 mr-1" />
              {isSubmitting ? '...' : 'Setujui'}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="shrink-0"
              onClick={() => setRejectDialogOpen(true)}
              disabled={isSubmitting}
            >
              <XCircle className="w-3 h-3" />
            </Button>
          </>
        )}
      </div>
      {expanded && (
        <div className="border-t bg-slate-50/50 px-3 py-2 text-sm">
          <div className="flex justify-end mb-2 no-print">
            <Button type="button" size="sm" variant="outline" disabled={printing} onClick={handlePrint}>
              <Printer className="w-3 h-3 mr-1" />
              {printing ? '...' : 'Cetak PO'}
            </Button>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 mb-2 pb-2 border-b border-slate-100">
            <span>
              <span className="font-medium text-slate-700">Dibuat oleh:</span>{' '}
              {poCreatorLabel(po)}
            </span>
            <span>
              <span className="font-medium text-slate-700">Waktu buat:</span>{' '}
              {formatDateTime(str(po.createdAt || po.tanggal))}
            </span>
            {!!po.requestedAt && (
              <span>
                <span className="font-medium text-slate-700">Diajukan:</span>{' '}
                {formatDateTime(str(po.requestedAt))}
              </span>
            )}
            {!!approvedBy.userName && (
              <span>
                <span className="font-medium text-slate-700">Disetujui:</span>{' '}
                {str(approvedBy.userName)}
                {!!po.approvedAt && ` · ${formatDateTime(str(po.approvedAt))}`}
              </span>
            )}
            {!!lastEditedBy.userName && (
              <span>
                <span className="font-medium text-slate-700">Terakhir diedit:</span>{' '}
                {str(lastEditedBy.userName)}
                {!!po.lastEditedAt && ` · ${formatDateTime(str(po.lastEditedAt))}`}
              </span>
            )}
          </div>
          {!!po.vendorSyncError && poStatus === 'APPROVED' && !vendorSoLabel && (
            <p className="text-xs text-red-700 mb-2 rounded border border-red-200 bg-red-50 px-2 py-1.5">
              <span className="font-medium">Gagal sync CreateSO:</span> {str(po.vendorSyncError)}
              <span className="block text-[10px] text-red-600 mt-0.5">
                Klik Kirim ke vendor untuk coba lagi (recovery)
              </span>
            </p>
          )}
          {failedVendors.length > 0 && canApprove && onSyncVendorForVendor && (
            <div className="text-xs mb-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 space-y-1">
              <p className="font-medium text-red-800">Vendor gagal dikirim:</p>
              {failedVendors.map((sub) => {
                const vid = str(sub.vendorTenantId);
                const retryKey = `${poId}:${vid}`;
                return (
                  <div key={vid} className="flex flex-wrap items-center gap-2 text-red-700">
                    <span>{vendorNameById[vid] || vid}: {str(sub.error)}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px] px-2"
                      disabled={submitting === retryKey}
                      onClick={() => onSyncVendorForVendor(vid)}
                    >
                      <RefreshCw className={`w-3 h-3 mr-1 ${submitting === retryKey ? 'animate-spin' : ''}`} />
                      Retry
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
          {!!vendorSoLabel && (
            <p className="text-xs text-slate-600 mb-2 rounded border border-slate-200 bg-white px-2 py-1.5">
              <span className="font-medium text-slate-700">SO vendor:</span>{' '}
              {vendorSoLabel}
            </p>
          )}
          {!vendorSoLabel && ['SUBMITTED', 'CONFIRMED', 'PARTIAL_CANCELLED', 'PARTIAL_SHIPPED', 'SHIPPED'].includes(poStatus) && !isOptimistic && (
            <p className="text-xs text-amber-800 mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5">
              Nomor SO belum tersinkron dari sales.app. Refresh halaman atau gunakan tombol <strong>Sync SO</strong>.
            </p>
          )}
          {!!po.purchaseRequirementNo && (
            <p className="text-xs text-slate-600 mb-2 rounded border border-slate-200 bg-white px-2 py-1.5">
              <span className="font-medium text-slate-700">Dari Kebutuhan Beli (Rencana Produksi):</span>{' '}
              <span className="font-mono">{str(po.purchaseRequirementNo)}</span>
            </p>
          )}
          {!!po.revisedFromNoPO && (
            <p className="text-xs text-slate-600 mb-2 rounded border border-slate-200 bg-white px-2 py-1.5">
              <span className="font-medium text-slate-700">Revisi dari:</span>{' '}
              <span className="font-mono">{str(po.revisedFromNoPO)}</span>
            </p>
          )}
          {!!po.supersededByNoPO && (
            <p className="text-xs text-amber-800 mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5">
              <span className="font-medium">Digantikan oleh:</span>{' '}
              <span className="font-mono">{str(po.supersededByNoPO)}</span>
              {' — history PO ini tetap disimpan'}
            </p>
          )}
          {!!po.catatan && (
            <p className="text-xs text-slate-600 mb-2">
              <span className="font-medium">Catatan:</span> {str(po.catatan)}
            </p>
          )}
          {!!po.rejectReason && (
            <p className="text-xs text-red-600 mb-2">
              <span className="font-medium">Alasan ditolak:</span> {str(po.rejectReason)}
            </p>
          )}
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 border-b">
                <th className="text-left py-1 pr-2">Kode</th>
                <th className="text-left py-1 pr-2">Produk</th>
                <th className="text-right py-1 pr-2">Estimasi</th>
                <th className="text-right py-1 pr-2">Qty</th>
                <th className="text-center py-1">Satuan</th>
              </tr>
            </thead>
            <tbody>
              {poItems.map((it: JsonObject) => {
                const cancelled = it.cancelled === true;
                return (
                <tr
                  key={str(it.lineId || it.kode)}
                  className={`border-b border-slate-100 last:border-0 ${cancelled ? 'bg-rose-50/70 text-slate-400' : ''}`}
                >
                  <td className={`py-1.5 pr-2 font-mono ${cancelled ? 'line-through' : ''}`}>{str(it.kode)}</td>
                  <td className={`py-1.5 pr-2 ${cancelled ? 'line-through' : ''}`}>
                    {str(it.nama)}
                    {cancelled && (
                      <span className="ml-1.5 inline-block text-[10px] font-medium px-1 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-200 no-underline align-middle">
                        Dibatalkan
                      </span>
                    )}
                    {cancelled && !!it.cancelReason && (
                      <div className="text-[10px] text-rose-600 mt-0.5 no-underline line-clamp-3">
                        {str(it.cancelReason)}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 text-right whitespace-nowrap text-slate-600">
                    {it.estimasiHarga ? formatIDR(num(it.estimasiHarga)) : '—'}
                  </td>
                  <td className="py-1.5 text-right whitespace-nowrap">
                    {cancelled
                      ? <span className="line-through">{formatNumber(num(it.qtyOriginal ?? it.qty))}</span>
                      : formatNumber(num(it.qty))}
                  </td>
                  <td className="py-1.5 text-center text-slate-600">{str(it.satuan) || '—'}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
          {poItems.some((it) => it.cancelled) && (
            <p className="text-[10px] text-rose-600 mt-2">
              Baris dicoret = item dibatalkan di sales.app (SO vendor). Item aktif tetap diproses.
            </p>
          )}
          {cancelledSoLines.length > 0 && (
            <div className="mt-3 border-t border-rose-100 pt-2 text-xs">
              <p className="font-semibold text-rose-700 mb-1">Riwayat pembatalan SO vendor</p>
              <ul className="space-y-1">
                {cancelledSoLines.map((row, idx) => (
                  <li key={idx} className="text-slate-600 bg-rose-50/50 rounded px-2 py-1">
                    <span className="font-mono line-through">{str(row.kode)}</span>
                    {' '}{str(row.nama)}
                    {row.noSO ? ` · SO ${str(row.noSO)}` : ''}
                    {row.reason ? (
                      <span className="block text-[10px] text-rose-700 mt-0.5">{str(row.reason)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {vendorSubs.some((s) => str(s.status) === 'CANCELLED') && (
            <div className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded px-2 py-1.5">
              <span className="font-medium">SO vendor dibatalkan:</span>
              {vendorSubs.filter((s) => str(s.status) === 'CANCELLED').map((sub) => (
                <div key={str(sub.vendorTenantId)} className="mt-0.5">
                  {vendorNameById[str(sub.vendorTenantId)] || str(sub.vendorTenantId)}
                  {sub.vendorNoSO ? ` (${str(sub.vendorNoSO)})` : ''}
                  {sub.cancelReason ? ` — ${str(sub.cancelReason)}` : ''}
                </div>
              ))}
            </div>
          )}
          {(!!po.vendorNoDO || !!po.vendorNoInvoice) && (
            <div className="mt-2 text-xs text-slate-600">
              {!!po.vendorNoDO && <span className="mr-3">DO: {str(po.vendorNoDO)}</span>}
              {!!po.vendorNoInvoice && <span>Invoice: {str(po.vendorNoInvoice)}</span>}
            </div>
          )}
        </div>
      )}
      <AlertDialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Tolak PO</AlertDialogTitle>
            <AlertDialogDescription>
              Masukkan alasan penolakan untuk PO {str(po.noPO)}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Label htmlFor="reject-reason">Alasan penolakan</Label>
            <Input
              id="reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Contoh: Stok sudah mencukupi, harga terlalu tinggi, dll."
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              setRejectDialogOpen(false);
              setRejectReason('');
            }}>
              Batal
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleReject}>
              Tolak
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus PO draft?</AlertDialogTitle>
            <AlertDialogDescription>
              PO {str(po.noPO)} akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                setDeleteDialogOpen(false);
                onDeleteDraft?.();
              }}
            >
              Hapus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={reviseDialogOpen} onOpenChange={setReviseDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Buat ulang PO?</AlertDialogTitle>
            <AlertDialogDescription>
              PO {str(po.noPO)} tetap tersimpan sebagai history ({poStatus}). Sistem akan membuat
              draft baru dengan nomor PO baru; item disalin agar bisa direvisi lalu diajukan ulang.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-orange-600 hover:bg-orange-700"
              onClick={() => {
                setReviseDialogOpen(false);
                onRevise?.();
              }}
            >
              Buat draft baru
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {printing && (
        <PrintPortal>
          <div className="doc-print-host">
            <CustomerPoDocument
              po={po}
              tenantName={tenantName}
              vendorNameById={vendorNameById}
              printId={PO_PRINT_ID}
            />
          </div>
        </PrintPortal>
      )}
    </div>
  );
}
