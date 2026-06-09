'use client';

import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';

export default function BulkSelectionBar({
  count,
  entityLabel = 'item',
  onDelete,
  onClear,
  deleting = false,
}) {
  if (count <= 0) return null;
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-orange-50 border border-orange-200 rounded-lg text-sm">
      <span className="font-medium text-orange-900">{count} {entityLabel} dipilih</span>
      {onDelete && (
        <Button size="sm" variant="destructive" onClick={onDelete} disabled={deleting}>
          <Trash2 className="w-4 h-4 mr-1" />
          {deleting ? 'Menghapus...' : 'Hapus terpilih'}
        </Button>
      )}
      {onClear && (
        <button type="button" className="text-orange-700 hover:underline text-xs" onClick={onClear}>
          Batal pilih
        </button>
      )}
    </div>
  );
}
