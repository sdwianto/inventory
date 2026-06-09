'use client';

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';
import { Printer, Save, Info } from 'lucide-react';
import Receipt from '@/components/Receipt';
import PrintPortal, { printReceipt } from '@/components/PrintPortal';
import {
  DEFAULT_PRINTER_SETTINGS,
  PRINTER_PROFILES,
  getPrinterSettings,
  savePrinterSettings,
  resolvePrintLayout,
} from '@/lib/printer-settings';

const SAMPLE_TRX = {
  noNota: 'PREVIEW-001',
  tanggal: new Date().toISOString(),
  kasirName: 'Kasir Demo',
  lokasi: 'Toko Utama',
  paymentMethod: 'TUNAI',
  tenantName: 'Toko Demo',
  store: {
    companyName: 'Toko Demo',
    companyAddress: 'Jl. Contoh No. 1',
    companyPhone: '08123456789',
    receiptFooterText: 'Terima Kasih',
    showLogoOnReceipt: false,
  },
  items: [
    { nama: 'Produk Contoh Panjang Nama', qty: 2, satuan: 'PCS', harga: 15000, jumlah: 30000 },
    { nama: 'Barang B', qty: 1, satuan: 'PCS', harga: 8500, jumlah: 8500 },
  ],
  subTotal: 38500,
  diskonNota: 0,
  ppn: 0,
  total: 38500,
  bayar: 50000,
  kembali: 11500,
  mode: 'KASIR',
};

export default function PrinterSettingsPage() {
  const [form, setForm] = useState({ ...DEFAULT_PRINTER_SETTINGS });
  const [layout, setLayout] = useState(() => resolvePrintLayout());

  useEffect(() => {
    const s = getPrinterSettings();
    setForm(s);
    setLayout(resolvePrintLayout(s));
  }, []);

  const profile = PRINTER_PROFILES[form.profileId] || PRINTER_PROFILES['epson-tm-u220'];

  const save = () => {
    savePrinterSettings(form);
    setLayout(resolvePrintLayout(form));
    toast.success('Pengaturan printer disimpan');
  };

  const testPrint = async () => {
    setLayout(resolvePrintLayout(form));
    await printReceipt(500);
  };

  return (
    <AppShell>
      <div className="p-4 md:p-6 max-w-3xl space-y-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Printer className="w-6 h-6" /> Pengaturan Printer Struk
          </h1>
          <p className="text-sm text-slate-500">
            Disimpan di browser ini (localStorage). Setiap PC/kasir bisa punya profil berbeda.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Profil printer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Model / tipe kertas</Label>
              <select
                className="mt-1 w-full border rounded-md px-3 py-2 text-sm"
                value={form.profileId}
                onChange={(e) => setForm({ ...form, profileId: e.target.value })}
              >
                {Object.values(PRINTER_PROFILES).map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              <p className="text-xs text-slate-500 mt-1">
                Lebar kertas {profile.paperWidthMm} mm · area cetak ~{profile.printableWidthMm} mm ·
                ~{profile.charsPerLine} karakter/baris
              </p>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.showLogoOnPrint === true}
                onChange={(e) =>
                  setForm({
                    ...form,
                    showLogoOnPrint: e.target.checked ? true : null,
                  })
                }
              />
              Paksa tampilkan logo saat cetak
            </label>
            <p className="text-xs text-slate-500 -mt-2">
              Untuk Epson TM-U220 disarankan <strong>tidak</strong> centang (logo lambat &amp; buram di printer impact).
              Kosongkan centang = ikut profil ({profile.showLogoOnPrint ? 'logo on' : 'logo off'}).
            </p>

            <div>
              <Label>Feed tambahan bawah struk (mm)</Label>
              <input
                type="number"
                min={0}
                max={30}
                className="mt-1 w-full border rounded-md px-3 py-2 text-sm"
                value={form.extraFeedMm ?? 0}
                onChange={(e) =>
                  setForm({ ...form, extraFeedMm: parseInt(e.target.value || '0', 10) })
                }
              />
              <p className="text-xs text-slate-500 mt-1">
                Ruang kosong sebelum tear — TM-U220 biasanya +{profile.feedMm} mm dari profil.
              </p>
            </div>

            <div className="flex gap-2 pt-2">
              <Button onClick={save} className="bg-orange-500 hover:bg-orange-600">
                <Save className="w-4 h-4 mr-1" /> Simpan
              </Button>
              <Button variant="outline" onClick={testPrint}>
                <Printer className="w-4 h-4 mr-1" /> Cetak contoh
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-blue-200 bg-blue-50/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2 text-blue-900">
              <Info className="w-4 h-4" /> Epson TM-U220 — setup Windows
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-blue-900 space-y-2">
            <ol className="list-decimal list-inside space-y-1">
              <li>Install driver resmi Epson TM-U220 (USB/parallel).</li>
              <li>
                <strong>Printer Properties → Preferences:</strong> kertas roll{' '}
                <strong>80 mm</strong> (atau 76 mm jika tersedia), margin <strong>None/Minimum</strong>.
              </li>
              <li>
                Saat dialog cetak browser: pilih printer <strong>{profile.driverHint}</strong>, skala{' '}
                <strong>100%</strong>, matikan header/footer browser.
              </li>
              <li>Set sebagai printer default di PC kasir agar F2 langsung ke TM-U220.</li>
            </ol>
            <p className="text-xs text-blue-800 pt-1">
              Aplikasi memakai cetak browser (bukan ESC/POS raw). Driver Epson yang mengonversi layout ke dot matrix.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Preview layout</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className="bg-white border shadow-inner mx-auto font-mono text-black p-3"
              style={{
                width: `${layout.paperWidthMm}mm`,
                fontSize: `${layout.fontSizePx}px`,
                lineHeight: layout.lineHeight,
              }}
            >
              <Receipt trx={SAMPLE_TRX} layout={layout} preview />
            </div>
          </CardContent>
        </Card>
      </div>

      <PrintPortal>
        <Receipt trx={SAMPLE_TRX} layout={layout} />
      </PrintPortal>
    </AppShell>
  );
}
