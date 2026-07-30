'use client';

import type { JsonObject } from '@/types/json';
import { str } from '@/types/json';
import { Suspense } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import PoCalendar from '@/components/PoCalendar';
import PoFormDialog from '@/components/pembelian-po/PoFormDialog';
import PoListCard from '@/components/pembelian-po/PoListCard';
import { Button } from '@/components/ui/button';
import {
  CalendarDays, Plus, RefreshCw, ShoppingBag,
} from 'lucide-react';
import { formatArrivalLabel, type PoArrivalFields } from '@/lib/po-calendar';
import { useCustomerPoPage } from '@/lib/hooks/use-customer-po-page';

function CustomerPoPageContent() {
  const {
    user,
    list,
    canCreate,
    canRequest,
    canDirectSubmit,
    canApprove,
    pendingVendorSyncCount,
    runAutoVendorSync,
    vendorSyncJobId,
    month,
    setMonth,
    selectedDate,
    showAll,
    setShowAll,
    handleSelectDate,
    listTitle,
    filteredList,
    expandedId,
    setExpandedId,
    hasMore,
    loadMore,
    loadingMore,
    createOpen,
    setCreateOpen,
    editingPo,
    createDate,
    setCreateDate,
    lines,
    lineDetails,
    lineSummary,
    catatan,
    setCatatan,
    saving,
    vendorTierMap,
    defaultTier,
    onProductPick,
    openCreate,
    openEdit,
    canEditPo,
    addLine,
    removeLine,
    selectProduct,
    updateLine,
    updateFormItemUom,
    createPo,
    saveEditPo,
    submitting,
    requestApproval,
    approvePo,
    syncVendorPo,
    syncVendorForVendorPo,
    syncSoLinesPo,
    rejectPo,
    submitPo,
    vendorNameById,
    closeFormDialog,
    dismissFormWithAutosave,
    deleteDraftPo,
  } = useCustomerPoPage();

  return (
    <>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <ShoppingBag className="w-6 h-6" /> PO ke Vendor
            </h1>
            <p className="text-sm text-slate-500">
              Staff gudang / supervisor buat PO → admin setujui → kirim ke vendor otomatis saat sales.app online
            </p>
            {pendingVendorSyncCount > 0 && (
              <p className="text-xs text-emerald-700 mt-1 flex items-center gap-1">
                <RefreshCw className="w-3 h-3" />
                {pendingVendorSyncCount} PO menunggu kirim ke sales.app
              </p>
            )}
          </div>
          {canCreate && (
            <Button onClick={() => openCreate(selectedDate || new Date())} className="bg-orange-500 hover:bg-orange-600">
              <Plus className="w-4 h-4 mr-1" /> Buat PO
            </Button>
          )}
          {pendingVendorSyncCount > 0 && canApprove && (
            <Button
              variant="outline"
              className="border-emerald-300 text-emerald-800 hover:bg-emerald-50"
              onClick={() => void runAutoVendorSync()}
              disabled={!!vendorSyncJobId}
            >
              <RefreshCw className={`w-4 h-4 mr-1 ${vendorSyncJobId ? 'animate-spin' : ''}`} />
              Sync Vendor
            </Button>
          )}
        </div>
        <OperationalScopeBar />

        <div className="grid gap-4 lg:grid-cols-[minmax(220px,280px)_1fr]">
          <div className="bg-white border rounded-xl p-3 shadow-sm lg:max-w-[280px]">
            <div className="flex items-center gap-2 mb-2">
              <CalendarDays className="w-4 h-4 text-orange-500" />
              <h2 className="font-semibold text-sm">Kalender Kedatangan</h2>
            </div>
            <PoCalendar
              pos={list as PoArrivalFields[]}
              month={month}
              onMonthChange={setMonth}
              selectedDate={selectedDate}
              onSelectDate={handleSelectDate}
              onCreateForDate={openCreate}
            />
          </div>

          <div className="bg-white border rounded-xl p-4 shadow-sm flex flex-col min-h-[320px]">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div>
                <h2 className="font-semibold">{listTitle}</h2>
                {selectedDate && !showAll && (
                  <p className="text-xs text-slate-500">{formatArrivalLabel(selectedDate)}</p>
                )}
              </div>
              <div className="flex gap-2">
                {selectedDate && (
                  <Button variant="outline" size="sm" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? 'Filter tanggal' : 'Lihat semua'}
                  </Button>
                )}
                {selectedDate && canCreate && (
                  <Button size="sm" onClick={() => openCreate(selectedDate)} className="bg-orange-500 hover:bg-orange-600">
                    <Plus className="w-3 h-3 mr-1" /> PO baru
                  </Button>
                )}
              </div>
            </div>

            {!filteredList.length ? (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-400 py-12 text-sm">
                <CalendarDays className="w-10 h-10 mb-2 opacity-40" />
                {selectedDate && !showAll
                  ? 'Belum ada PO untuk tanggal ini — klik + di kalender untuk buat'
                  : 'Belum ada PO — pilih tanggal di kalender'}
              </div>
            ) : (
              <div className="space-y-2 overflow-y-auto max-h-[520px] pr-1">
                {filteredList.map((po: JsonObject) => {
                  const poId = str(po.id);
                  return (
                    <PoListCard
                      key={poId}
                      po={po}
                      expanded={expandedId === poId}
                      onToggleExpand={() => setExpandedId(expandedId === poId ? null : poId)}
                      vendorNameById={vendorNameById}
                      canEdit={canEditPo(po)}
                      canRequest={canRequest}
                      canDirectSubmit={canDirectSubmit}
                      canApprove={canApprove}
                      user={user}
                      submitting={submitting}
                      onEdit={() => openEdit(po)}
                      onRequestApproval={() => requestApproval(poId)}
                      onSubmit={() => submitPo(poId)}
                      onSyncVendor={() => syncVendorPo(poId)}
                      onSyncVendorForVendor={(vendorTenantId) => syncVendorForVendorPo(poId, vendorTenantId)}
                      onSyncSoLines={() => syncSoLinesPo(poId)}
                      onApprove={() => approvePo(poId)}
                      onReject={(reason) => rejectPo(poId, reason)}
                      onDeleteDraft={() => deleteDraftPo(poId)}
                      tenantName={str(user?.tenantName || user?.name)}
                    />
                  );
                })}
                {hasMore && (
                  <div className="pt-2 text-center">
                    <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                      {loadingMore ? 'Memuat…' : 'Muat lebih banyak'}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <PoFormDialog
        open={createOpen}
        onOpenChange={(open) => {
          if (open) {
            setCreateOpen(true);
            return;
          }
          void dismissFormWithAutosave();
        }}
        editingPo={editingPo}
        createDate={createDate}
        onCreateDateChange={setCreateDate}
        lines={lines}
        lineDetails={lineDetails}
        lineSummary={lineSummary}
        catatan={catatan}
        onCatatanChange={setCatatan}
        saving={saving}
        vendorTierMap={vendorTierMap}
        defaultTier={defaultTier}
        onProductPick={onProductPick}
        onAddLine={addLine}
        onRemoveLine={removeLine}
        onSelectProduct={selectProduct}
        onUpdateLine={updateLine}
        onUpdateFormItemUom={updateFormItemUom}
        onSave={editingPo ? saveEditPo : createPo}
        onCancel={closeFormDialog}
      />
    </>
  );
}

export default function CustomerPoPage() {
  return (
    <Suspense
      fallback={(
        <div className="p-6 text-sm text-slate-500">Memuat pembelian PO…</div>
      )}
    >
      <CustomerPoPageContent />
    </Suspense>
  );
}
