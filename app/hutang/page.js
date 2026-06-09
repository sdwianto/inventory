'use client';

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Banknote, DollarSign } from 'lucide-react';
import { formatIDR, formatDate } from '@/lib/format';
import { getUser } from '@/lib/auth-client';

const AGING_COLORS = {
  CURRENT: 'bg-green-100 text-green-800', '1-30': 'bg-yellow-100 text-yellow-800',
  '31-60': 'bg-orange-100 text-orange-800', '61-90': 'bg-red-100 text-red-800',
  '90+': 'bg-red-200 text-red-900', LUNAS: 'bg-slate-100 text-slate-600',
};

export default function HutangVendorPage() {
  const [list, setList] = useState([]);
  const [showPay, setShowPay] = useState(null);
  const [payAmount, setPayAmount] = useState(0);
  const [paying, setPaying] = useState(false);

  const load = () => fetch('/api/hutang').then((r) => r.json()).then(setList);
  useEffect(() => { load(); }, []);

  const doPay = async () => {
    if (!showPay) return;
    const amount = parseInt(payAmount, 10);
    if (amount <= 0 || amount > showPay.sisa) { toast.error('Nominal tidak valid'); return; }
    setPaying(true);
    try {
      const user = getUser();
      const res = await fetch(`/api/hutang/${showPay.id}/bayar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, metode: 'TUNAI', userName: user?.name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal');
      toast.success(`Pembayaran ${formatIDR(amount)} tercatat`);
      setShowPay(null);
      load();
    } catch (e) { toast.error(e.message); }
    setPaying(false);
  };

  const outstanding = (Array.isArray(list) ? list : []).filter((p) => p.status !== 'LUNAS').reduce((s, p) => s + (p.sisa || 0), 0);

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Banknote className="w-6 h-6" /> Hutang Vendor</h1>
          <p className="text-sm text-slate-500">Otomatis dari webhook invoice.posted sales.app · Outstanding: {formatIDR(outstanding)}</p>
        </div>
        <OperationalScopeBar />
        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">No. Hutang</th>
                <th className="px-3 py-2 text-left">Invoice Vendor</th>
                <th className="px-3 py-2 text-left">No. DO</th>
                <th className="px-3 py-2 text-left">Jatuh Tempo</th>
                <th className="px-3 py-2 text-right">Sisa</th>
                <th className="px-3 py-2 text-center">Aging</th>
                <th className="px-3 py-2 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {!list?.length && <tr><td colSpan={7} className="text-center py-10 text-slate-400">Belum ada hutang — post invoice di sales.app</td></tr>}
              {(Array.isArray(list) ? list : []).map((h) => (
                <tr key={h.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{h.noHutang}</td>
                  <td className="px-3 py-2 font-mono text-xs">{h.noInvoice}</td>
                  <td className="px-3 py-2 font-mono text-xs">{h.noDO || '—'}</td>
                  <td className="px-3 py-2 text-xs">{formatDate(h.jatuhTempo)}</td>
                  <td className="px-3 py-2 text-right">{h.status === 'LUNAS' ? '—' : formatIDR(h.sisa)}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs ${AGING_COLORS[h.aging] || 'bg-slate-100'}`}>{h.aging}</span>
                  </td>
                  <td className="px-3 py-2 text-center">
                    {h.status !== 'LUNAS' && (
                      <Button size="sm" variant="outline" onClick={() => { setShowPay(h); setPayAmount(h.sisa); }}>
                        <DollarSign className="w-3 h-3 mr-1" /> Bayar
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={!!showPay} onOpenChange={(o) => !o && setShowPay(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Bayar Hutang — {showPay?.noInvoice}</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-500">Sisa: {formatIDR(showPay?.sisa || 0)}</p>
          <Input type="number" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
          <Button onClick={doPay} disabled={paying} className="w-full bg-orange-500 hover:bg-orange-600">
            {paying ? '...' : 'Simpan Pembayaran'}
          </Button>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
