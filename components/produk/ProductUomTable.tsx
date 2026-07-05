'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatIDR } from '@/lib/format';
import type { ProductUomFormRow } from '@/lib/uom/form';
import {
  addUomRow,
  removeUomRow,
  setBaseUomRow,
} from '@/lib/uom/form';
import { UomPriceCell } from '@/components/produk/PriceWithMargin';

const SELECT_CLASS =
  'w-full border border-slate-200 rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-200 disabled:bg-slate-50 disabled:text-slate-500';

type MetaItem = { id: string; nama: string };

type ProductUomTableProps = {
  rows: ProductUomFormRow[];
  onChange: (rows: ProductUomFormRow[]) => void;
  satuanList: MetaItem[];
  hargaBeli: number;
  readOnly?: boolean;
};

function beliPerRow(hargaBeli: number, row: ProductUomFormRow): number {
  const beli = Number(hargaBeli) || 0;
  return beli * (row.isBase ? 1 : Math.max(1, row.factorToBase));
}

export function ProductUomTable({
  rows,
  onChange,
  satuanList,
  hargaBeli,
  readOnly = false,
}: ProductUomTableProps) {
  const patchRow = (index: number, patch: Partial<ProductUomFormRow>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className="col-span-2 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-slate-800">Satuan produk</p>
          <p className="text-[11px] text-slate-500">
            Stok dicatat di satuan dasar (★). Satuan lain punya faktor konversi ke dasar.
          </p>
        </div>
        {!readOnly && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(addUomRow(rows))}
          >
            <Plus className="w-3.5 h-3.5 mr-1" /> Tambah satuan
          </Button>
        )}
      </div>

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead className="bg-slate-50 text-xs uppercase text-slate-600">
            <tr>
              <th className="px-2 py-2 text-left w-8">Dasar</th>
              <th className="px-2 py-2 text-left">Satuan</th>
              <th className="px-2 py-2 text-center w-20">Faktor</th>
              <th className="px-2 py-2 text-left">Barcode</th>
              <th className="px-2 py-2 text-right">Ecer</th>
              <th className="px-2 py-2 text-right">Grosir</th>
              <th className="px-2 py-2 text-right">Spesial</th>
              {!readOnly && <th className="px-2 py-2 w-10" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const beliRow = beliPerRow(hargaBeli, row);
              return (
                <tr key={`uom-${i}-${row.satuan}`} className="border-t">
                  <td className="px-2 py-2 text-center">
                    <input
                      type="radio"
                      name="base-uom"
                      checked={row.isBase}
                      disabled={readOnly}
                      onChange={() => onChange(setBaseUomRow(rows, i))}
                      title="Satuan dasar (stok)"
                    />
                  </td>
                  <td className="px-2 py-2">
                    {readOnly ? (
                      <span className="font-mono text-xs uppercase">{row.satuan}</span>
                    ) : (
                      <select
                        className={SELECT_CLASS}
                        value={row.satuan}
                        onChange={(e) => patchRow(i, { satuan: e.target.value.toUpperCase() })}
                        disabled={satuanList.length === 0}
                      >
                        <option value="">{satuanList.length ? '— Pilih —' : '— Belum ada —'}</option>
                        {satuanList.map((s) => (
                          <option key={s.id} value={s.nama}>{s.nama}</option>
                        ))}
                        {row.satuan && !satuanList.some((s) => s.nama === row.satuan) && (
                          <option value={row.satuan}>{row.satuan}</option>
                        )}
                      </select>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {row.isBase ? (
                      <span className="block text-center text-xs text-slate-500">1</span>
                    ) : readOnly ? (
                      <span className="block text-center font-mono text-xs">×{row.factorToBase}</span>
                    ) : (
                      <Input
                        type="number"
                        min={2}
                        step={1}
                        className="h-8 text-center font-mono text-xs"
                        value={row.factorToBase}
                        onChange={(e) => patchRow(i, { factorToBase: parseInt(e.target.value || '1', 10) || 1 })}
                        title="1 satuan ini = N satuan dasar"
                      />
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {readOnly ? (
                      <span className="font-mono text-xs text-slate-500">{row.barcode || '—'}</span>
                    ) : (
                      <Input
                        className="h-8 font-mono text-xs"
                        value={row.barcode}
                        onChange={(e) => patchRow(i, { barcode: e.target.value })}
                        placeholder="Opsional"
                      />
                    )}
                  </td>
                  <td className="px-2 py-2 align-top">
                    <UomPriceCell
                      hargaBeli={beliRow}
                      value={row.hargaEcer}
                      onChange={(hargaEcer) => patchRow(i, { hargaEcer })}
                      readOnly={readOnly}
                    />
                  </td>
                  <td className="px-2 py-2 align-top">
                    <UomPriceCell
                      hargaBeli={beliRow}
                      value={row.hargaGrosir}
                      onChange={(hargaGrosir) => patchRow(i, { hargaGrosir })}
                      readOnly={readOnly}
                    />
                  </td>
                  <td className="px-2 py-2 align-top">
                    <UomPriceCell
                      hargaBeli={beliRow}
                      value={row.hargaSpesial}
                      onChange={(hargaSpesial) => patchRow(i, { hargaSpesial })}
                      readOnly={readOnly}
                    />
                  </td>
                  {!readOnly && (
                    <td className="px-2 py-2 text-center">
                      <button
                        type="button"
                        className="p-1 rounded text-red-600 hover:bg-red-50 disabled:opacity-30"
                        disabled={rows.length <= 1}
                        onClick={() => onChange(removeUomRow(rows, i))}
                        title="Hapus satuan"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {Number(hargaBeli) > 0 && (
        <p className="text-[11px] text-slate-500">
          Harga beli produk: {formatIDR(hargaBeli)} per satuan dasar — margin dihitung per kemasan.
        </p>
      )}
    </div>
  );
}
