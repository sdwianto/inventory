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
  CheckCircle2, ChevronDown, ChevronRight, Pencil, RefreshCw, Send, XCircle,
} from 'lucide-react';
import { formatDate, formatDateTime, formatIDR, formatNumber } from '@/lib/format';
import { getPoArrivalDate, PO_STATUS_STYLE } from '@/lib/po-calendar';
import { poCreatorLabel, formatPoVendorSoDisplay, isPendingOptimisticPo } from '@/lib/pembelian-po/helpers';
import { canRequestApprovalPoStatus } from '@/lib/pembelian-po/permissions';

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
  onApprove: () => void;
  onReject: (reason: string) => void;
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
  onApprove,
  onReject,
}: PoListCardProps) {
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

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
  const failedVendors = vendorSubs.filter((s) => str(s.status) === 'FAILED');
  const isSubmitting = submitting === poId || submitting.startsWith(`${poId}:`);

  const handleReject = () => {
    onReject(rejectReason || 'Ditolak admin');
    setRejectDialogOpen(false);
    setRejectReason('');
  };

  return (
    <div className="border rounded-lg overflow-hidden">
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
            </div>
          </div>
        </button>
        {canEdit && !isOptimistic && (
          <Button size="sm" variant="outline" className="shrink-0" onClick={onEdit}>
            <Pencil className="w-3 h-3 mr-1" />
            Edit
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
        {poStatus === 'APPROVED' && canApprove && !!po.vendorSyncPending && (
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
          {!!po.vendorSyncError && poStatus === 'APPROVED' && (
            <p className="text-xs text-amber-700 mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5">
              <span className="font-medium">Antrian kirim ke vendor:</span> {str(po.vendorSyncError)}
              <span className="block text-[10px] text-amber-600 mt-0.5">
                Akan dikirim otomatis saat sales.app online (atau klik Kirim ke vendor)
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
              {poItems.map((it: JsonObject) => (
                <tr key={str(it.lineId || it.kode)} className="border-b border-slate-100 last:border-0">
                  <td className="py-1.5 pr-2 font-mono">{str(it.kode)}</td>
                  <td className="py-1.5 pr-2">{str(it.nama)}</td>
                  <td className="py-1.5 text-right whitespace-nowrap text-slate-600">
                    {it.estimasiHarga ? formatIDR(num(it.estimasiHarga)) : '—'}
                  </td>
                  <td className="py-1.5 text-right whitespace-nowrap">{formatNumber(num(it.qty))}</td>
                  <td className="py-1.5 text-center text-slate-600">{str(it.satuan) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
    </div>
  );
}
