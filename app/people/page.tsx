'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { compressImageFile } from '@/lib/image-upload-client';
import { formatIDR } from '@/lib/format';
import {
  KITCHEN_PERSON_JENIS_LABELS,
  KITCHEN_PERSON_PERAN_LABELS,
  PERSON_ATTACHMENT_KIND_LABELS,
  PERSON_BANK_CATALOG,
  PERSON_DOC_MAX_BYTES,
  PERSON_FOTO_MAX_BYTES,
  type KitchenPersonAttachmentKind,
  type KitchenPersonJenis,
  type KitchenPersonPeran,
  type PersonBankAccount,
  type PersonBankCode,
} from '@/lib/people/person';
import {
  PERSON_PAYMENT_STATUS_LABELS,
  type PersonPaymentStatus,
} from '@/lib/people/person-payment';
import { FileSpreadsheet, Pencil, Plus, RefreshCw, Trash2, Upload, Users } from 'lucide-react';

interface KitchenOpt {
  id: string;
  kode?: string;
  nama: string;
  aktif?: boolean;
}

interface PublicAttachment {
  id: string;
  kind: KitchenPersonAttachmentKind;
  title: string;
  originalName?: string;
  mimeType: string;
  sizeBytes: number;
  issuedAt?: string;
  expiresAt?: string;
}

interface PersonRow {
  id: string;
  kode: string;
  nama: string;
  jenis: KitchenPersonJenis;
  peran: KitchenPersonPeran;
  jabatan?: string;
  nik?: string;
  noTelp?: string;
  kitchenIds: string[];
  bankAccounts: PersonBankAccount[];
  aktif: boolean;
  effectiveFrom?: string;
  effectiveTo?: string;
  attachmentCount?: number;
  attachments?: PublicAttachment[];
  paymentCount?: number;
  lastPaidAt?: string | null;
  lastPaidAmount?: number;
}

interface InboxRow {
  id: string;
  amount: number;
  valueDate: string;
  description?: string;
  bankRef: string;
  counterpartyAccount?: string;
  counterpartyBank?: string;
  counterpartyName?: string;
  status: string;
  warnings?: string[];
}

interface PaymentRow {
  id: string;
  noDokumen?: string;
  tanggal: string;
  amount: number;
  bankCode?: string;
  accountNo?: string;
  accountName?: string;
  bankRef: string;
  status: PersonPaymentStatus;
}

type FormBank = {
  bankCode: PersonBankCode;
  accountNo: string;
  accountName: string;
  isPrimary: boolean;
};

const emptyForm = {
  nama: '',
  jenis: 'KARYAWAN' as KitchenPersonJenis,
  peran: 'JURU_MASAK' as KitchenPersonPeran,
  jabatan: '',
  nik: '',
  noTelp: '',
  kitchenIds: [] as string[],
  bankAccounts: [] as FormBank[],
  aktif: true,
  effectiveFrom: '',
  effectiveTo: '',
};

function primaryBank(row: PersonRow): string {
  const acc = (row.bankAccounts || []).find((a) => a.isPrimary) || row.bankAccounts?.[0];
  if (!acc) return '—';
  return `${acc.bankCode} · ${acc.accountNo}`;
}

function bankLabel(code?: string): string {
  if (!code) return '—';
  return PERSON_BANK_CATALOG.find((b) => b.code === code)?.nama || code;
}

async function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Gagal membaca berkas'));
    reader.readAsDataURL(file);
  });
}

export default function FoodProductionPeoplePage() {
  const [rows, setRows] = useState<PersonRow[]>([]);
  const [kitchens, setKitchens] = useState<KitchenOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PersonRow | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('identitas');
  const [q, setQ] = useState('');
  const [jenisFilter, setJenisFilter] = useState('ALL');
  const [kitchenFilter, setKitchenFilter] = useState('ALL');
  const [attachKind, setAttachKind] = useState<KitchenPersonAttachmentKind>('FOTO');
  const [attachTitle, setAttachTitle] = useState('');
  const [uploading, setUploading] = useState(false);
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);
  const [payFrom, setPayFrom] = useState('');
  const [payTo, setPayTo] = useState('');
  const [payStatus, setPayStatus] = useState('ALL');
  const [payApplied, setPayApplied] = useState({ from: '', to: '', status: 'ALL' });
  const [payTotalAmount, setPayTotalAmount] = useState(0);
  const [payTotal, setPayTotal] = useState(0);
  const [payHasMore, setPayHasMore] = useState(false);
  const [payLoading, setPayLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const csvFileRef = useRef<HTMLInputElement | null>(null);
  const [inbox, setInbox] = useState<InboxRow[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [pickerPeople, setPickerPeople] = useState<PersonRow[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [csvFileName, setCsvFileName] = useState('');
  const [importing, setImporting] = useState(false);
  const [pickPerson, setPickPerson] = useState<Record<string, string>>({});
  const [busyInboxId, setBusyInboxId] = useState<string | null>(null);

  const kitchenName = useCallback((id: string) => {
    const k = kitchens.find((x) => x.id === id);
    return k ? (k.kode ? `${k.kode} — ${k.nama}` : k.nama) : id;
  }, [kitchens]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (jenisFilter === 'KARYAWAN' || jenisFilter === 'RELAWAN') params.set('jenis', jenisFilter);
      if (kitchenFilter !== 'ALL') params.set('kitchenId', kitchenFilter);
      const qs = params.toString();
      const [peopleRes, kitchenRes] = await Promise.all([
        fetch(`/api/people${qs ? `?${qs}` : ''}`, { headers: { ...actingTenantHeaders() } }),
        fetch('/api/kitchens?aktif=1', { headers: { ...actingTenantHeaders() } }),
      ]);
      const people = await peopleRes.json();
      const kits = await kitchenRes.json();
      if (!peopleRes.ok) throw new Error(people?.error || 'Gagal memuat personel');
      setRows(Array.isArray(people) ? people : []);
      setKitchens(Array.isArray(kits) ? kits : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat personel');
    } finally {
      setLoading(false);
    }
  }, [q, jenisFilter, kitchenFilter]);

  const loadInbox = useCallback(async () => {
    setInboxLoading(true);
    try {
      const [inboxRes, peopleRes] = await Promise.all([
        fetch('/api/bank-txn?status=NEW', { headers: { ...actingTenantHeaders() } }),
        fetch('/api/people?aktif=1', { headers: { ...actingTenantHeaders() } }),
      ]);
      const data = await inboxRes.json();
      const people = await peopleRes.json();
      if (!inboxRes.ok) throw new Error(data?.error || 'Gagal memuat antrian mutasi');
      setInbox(Array.isArray(data) ? data : []);
      if (peopleRes.ok && Array.isArray(people)) setPickerPeople(people);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat antrian mutasi');
    } finally {
      setInboxLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadInbox();
  }, [loadInbox]);

  function resetPayState() {
    setPayments(null);
    setPayFrom('');
    setPayTo('');
    setPayStatus('ALL');
    setPayApplied({ from: '', to: '', status: 'ALL' });
    setPayTotalAmount(0);
    setPayTotal(0);
    setPayHasMore(false);
  }

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setTab('identitas');
    resetPayState();
    setOpen(true);
  }

  async function openEdit(row: PersonRow) {
    setTab('identitas');
    resetPayState();
    setOpen(true);
    try {
      const res = await fetch(`/api/people/${row.id}`, { headers: { ...actingTenantHeaders() } });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal memuat detail');
      const detail = data as PersonRow;
      setEditing(detail);
      setForm({
        nama: detail.nama || '',
        jenis: detail.jenis || 'KARYAWAN',
        peran: detail.peran || 'LAINNYA',
        jabatan: detail.jabatan || '',
        nik: detail.nik || '',
        noTelp: detail.noTelp || '',
        kitchenIds: Array.isArray(detail.kitchenIds) ? detail.kitchenIds : [],
        bankAccounts: (detail.bankAccounts || []).map((a) => ({
          bankCode: a.bankCode,
          accountNo: a.accountNo,
          accountName: a.accountName,
          isPrimary: !!a.isPrimary,
        })),
        aktif: detail.aktif !== false,
        effectiveFrom: detail.effectiveFrom || '',
        effectiveTo: detail.effectiveTo || '',
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat detail');
      setEditing(row);
      setForm({
        ...emptyForm,
        nama: row.nama,
        jenis: row.jenis,
        peran: row.peran,
        jabatan: row.jabatan || '',
        nik: row.nik || '',
        kitchenIds: row.kitchenIds || [],
        bankAccounts: (row.bankAccounts || []).map((a) => ({
          bankCode: a.bankCode,
          accountNo: a.accountNo,
          accountName: a.accountName,
          isPrimary: !!a.isPrimary,
        })),
        aktif: row.aktif !== false,
      });
    }
  }

  async function save() {
    if (!form.nama.trim()) {
      toast.error('Nama wajib diisi');
      return;
    }
    if (!form.nik.trim()) {
      toast.error('NIK wajib diisi');
      return;
    }
    setSaving(true);
    try {
      const url = editing ? `/api/people/${editing.id}` : '/api/people';
      const method = editing ? 'PUT' : 'POST';
      const body = {
        nama: form.nama,
        jenis: form.jenis,
        peran: form.peran,
        jabatan: form.jabatan,
        nik: form.nik,
        noTelp: form.noTelp,
        kitchenIds: form.kitchenIds,
        bankAccounts: form.bankAccounts,
        aktif: form.aktif,
        effectiveFrom: form.effectiveFrom || undefined,
        effectiveTo: form.effectiveTo || undefined,
      };
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menyimpan');
      toast.success(editing ? 'Personel diperbarui' : 'Personel ditambahkan');
      setEditing(data as PersonRow);
      await Promise.all([load(), loadInbox()]);
      if (!editing) setTab('lampiran');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyimpan');
    } finally {
      setSaving(false);
    }
  }

  async function deactivate() {
    if (!editing) return;
    if (!window.confirm(`Nonaktifkan ${editing.nama}?`)) return;
    try {
      const res = await fetch(`/api/people/${editing.id}`, {
        method: 'DELETE',
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menonaktifkan');
      toast.success('Personel dinonaktifkan');
      setOpen(false);
      await Promise.all([load(), loadInbox()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menonaktifkan');
    }
  }

  async function loadPayments(
    personId: string,
    offset = 0,
    over: { from?: string; to?: string; status?: string } = {},
  ) {
    const from = over.from ?? (offset > 0 ? payApplied.from : payFrom);
    const to = over.to ?? (offset > 0 ? payApplied.to : payTo);
    const status = over.status ?? (offset > 0 ? payApplied.status : payStatus);
    if (from && to && from > to) {
      toast.error('Tanggal dari tidak boleh setelah sampai');
      return;
    }
    setPayLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (status && status !== 'ALL') params.set('status', status);
      params.set('limit', '50');
      params.set('offset', String(offset));
      const res = await fetch(`/api/people/${personId}/payments?${params}`, {
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal memuat transfer');
      const items: PaymentRow[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.items) ? data.items : [];
      setPayments((prev) => (offset > 0 && prev ? [...prev, ...items] : items));
      setPayTotal(Number(data?.total || items.length));
      setPayTotalAmount(Number(data?.totalAmount || 0));
      setPayHasMore(Boolean(data?.hasMore));
      if (offset === 0) setPayApplied({ from, to, status });
    } catch (e) {
      if (offset === 0) setPayments([]);
      toast.error(e instanceof Error ? e.message : 'Gagal memuat transfer');
    } finally {
      setPayLoading(false);
    }
  }

  async function uploadAttachment(file: File) {
    if (!editing?.id) {
      toast.error('Simpan identitas personel dulu sebelum unggah lampiran');
      return;
    }
    setUploading(true);
    try {
      let dataBase64: string;
      if (attachKind === 'FOTO' || file.type.startsWith('image/')) {
        if (attachKind === 'FOTO') {
          dataBase64 = await compressImageFile(file, 1200, 0.85, PERSON_FOTO_MAX_BYTES - 20_000);
        } else {
          if (file.size > PERSON_DOC_MAX_BYTES) throw new Error('Dokumen maksimal 8MB');
          dataBase64 = await readFileDataUrl(file);
        }
      } else {
        if (file.size > PERSON_DOC_MAX_BYTES) throw new Error('Dokumen maksimal 8MB');
        dataBase64 = await readFileDataUrl(file);
      }
      const res = await fetch(`/api/people/${editing.id}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          kind: attachKind,
          title: attachTitle || file.name,
          originalName: file.name,
          dataBase64,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal unggah');
      setEditing(data as PersonRow);
      setAttachTitle('');
      toast.success('Lampiran ditambahkan');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal unggah');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function deleteAttachment(att: PublicAttachment) {
    if (!editing?.id) return;
    if (!window.confirm(`Hapus ${att.title || att.kind}?`)) return;
    try {
      const res = await fetch(`/api/people/${editing.id}/attachments/${att.id}`, {
        method: 'DELETE',
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menghapus');
      setEditing(data as PersonRow);
      toast.success('Lampiran dihapus');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menghapus');
    }
  }

  async function importMutasi() {
    if (!csvText.trim()) {
      toast.error('Tempel atau unggah CSV mutasi BNI');
      return;
    }
    setImporting(true);
    try {
      const res = await fetch('/api/bank-txn/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ csvText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal impor mutasi');
      const inserted = Number(data.inserted || 0);
      const duplicate = Number(data.duplicate || 0);
      const matched = Number(data.matched || 0);
      const unmatchedCount = Number(data.unmatchedCount || 0);
      toast.success(
        `Impor ${inserted} baris · ${duplicate} duplikat · ${matched} tercocokkan · ${unmatchedCount} antrian`,
      );
      if (Array.isArray(data.parseWarnings) && data.parseWarnings.length) {
        toast.message(String(data.parseWarnings[0]));
      }
      setImportOpen(false);
      setCsvText('');
      setCsvFileName('');
      await Promise.all([loadInbox(), load()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal impor mutasi');
    } finally {
      setImporting(false);
    }
  }

  async function matchInboxRow(row: InboxRow) {
    const personId = pickPerson[row.id];
    if (!personId) {
      toast.error('Pilih karyawan dulu');
      return;
    }
    setBusyInboxId(row.id);
    try {
      const res = await fetch(`/api/bank-txn/${row.id}/match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ personId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal mencocokkan');
      toast.success(data.alreadyMatched ? 'Sudah tercocokkan sebelumnya' : `Tercocokkan ${data.noDokumen || ''}`.trim());
      setPickPerson((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      await Promise.all([loadInbox(), load()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal mencocokkan');
    } finally {
      setBusyInboxId(null);
    }
  }

  async function ignoreInboxRow(row: InboxRow) {
    if (!window.confirm(`Abaikan mutasi ${row.bankRef}?`)) return;
    setBusyInboxId(row.id);
    try {
      const res = await fetch(`/api/bank-txn/${row.id}/ignore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal mengabaikan');
      toast.success('Mutasi diabaikan');
      await loadInbox();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal mengabaikan');
    } finally {
      setBusyInboxId(null);
    }
  }

  async function downloadAttachment(att: PublicAttachment) {
    if (!editing?.id) return;
    try {
      const res = await fetch(`/api/people/${editing.id}/attachments/${att.id}`, {
        headers: { ...actingTenantHeaders() },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || 'Gagal unduh');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.originalName || att.title || 'lampiran';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal unduh');
    }
  }

  const filteredKitchens = useMemo(
    () => kitchens.filter((k) => k.aktif !== false),
    [kitchens],
  );

  const matchablePeople = useMemo(
    () => pickerPeople.filter((r) => r.aktif !== false && (r.bankAccounts || []).length > 0),
    [pickerPeople],
  );

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Users className="h-5 w-5" />
            Personel
          </h1>
          <p className="text-sm text-muted-foreground">
            Staff & relawan operasional — identitas, rekening tujuan transfer, lampiran
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { void load(); void loadInbox(); }} disabled={loading || inboxLoading}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Muat ulang
          </Button>
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <FileSpreadsheet className="h-4 w-4 mr-1" />
            Impor mutasi BNI
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1" />
            Tambah Personel
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          className="max-w-xs"
          placeholder="Cari nama, kode, NIK"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Select value={jenisFilter} onValueChange={setJenisFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Semua jenis</SelectItem>
            <SelectItem value="KARYAWAN">{KITCHEN_PERSON_JENIS_LABELS.KARYAWAN}</SelectItem>
            <SelectItem value="RELAWAN">{KITCHEN_PERSON_JENIS_LABELS.RELAWAN}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={kitchenFilter} onValueChange={setKitchenFilter}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Semua dapur</SelectItem>
            {filteredKitchens.map((k) => (
              <SelectItem key={k.id} value={k.id}>
                {k.kode ? `${k.kode} — ${k.nama}` : k.nama}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium">Kode</th>
              <th className="text-left p-3 font-medium">Nama</th>
              <th className="text-left p-3 font-medium">Jenis</th>
              <th className="text-left p-3 font-medium">Peran</th>
              <th className="text-left p-3 font-medium">Dapur</th>
              <th className="text-left p-3 font-medium">Rekening</th>
              <th className="text-left p-3 font-medium">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-muted-foreground">Memuat…</td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-muted-foreground">
                  Belum ada personel. Tambahkan staff atau relawan.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-3 font-mono text-xs">{row.kode}</td>
                <td className="p-3 font-medium">{row.nama}</td>
                <td className="p-3">{KITCHEN_PERSON_JENIS_LABELS[row.jenis] || row.jenis}</td>
                <td className="p-3">{KITCHEN_PERSON_PERAN_LABELS[row.peran] || row.peran}</td>
                <td className="p-3 text-xs">
                  {(row.kitchenIds || []).length
                    ? row.kitchenIds.map(kitchenName).join(', ')
                    : '—'}
                </td>
                <td className="p-3 font-mono text-xs">{primaryBank(row)}</td>
                <td className="p-3">{row.aktif ? 'Aktif' : 'Nonaktif'}</td>
                <td className="p-3 text-right">
                  <Button variant="ghost" size="sm" onClick={() => void openEdit(row)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-md border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
          <div>
            <h2 className="text-sm font-semibold">Antrian belum cocok</h2>
            <p className="text-xs text-muted-foreground">
              Debet BNI SPPG yang belum terikat ke rekening personel
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void loadInbox()} disabled={inboxLoading}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Antrian
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Tanggal</th>
                <th className="text-left p-3 font-medium">Nominal</th>
                <th className="text-left p-3 font-medium">Keterangan</th>
                <th className="text-left p-3 font-medium">NTB</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {inboxLoading && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-muted-foreground">Memuat antrian…</td>
                </tr>
              )}
              {!inboxLoading && inbox.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-muted-foreground">
                    Tidak ada mutasi menunggu. Impor CSV BNI Direct untuk mengisi antrian.
                  </td>
                </tr>
              )}
              {inbox.map((row) => (
                <tr key={row.id} className="border-t align-top">
                  <td className="p-3 whitespace-nowrap">{row.valueDate}</td>
                  <td className="p-3 whitespace-nowrap font-medium">{formatIDR(row.amount)}</td>
                  <td className="p-3">
                    <div className="max-w-md text-xs leading-5">{row.description || '—'}</div>
                    {(row.counterpartyBank || row.counterpartyAccount || row.counterpartyName) && (
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {[row.counterpartyBank, row.counterpartyAccount, row.counterpartyName].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="p-3 font-mono text-xs">{row.bankRef}</td>
                  <td className="p-3">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Select
                        value={pickPerson[row.id] || undefined}
                        onValueChange={(v) => setPickPerson((prev) => ({ ...prev, [row.id]: v }))}
                      >
                        <SelectTrigger className="w-52 h-8 text-xs">
                          <SelectValue placeholder="Pilih karyawan" />
                        </SelectTrigger>
                        <SelectContent>
                          {matchablePeople.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.kode} — {p.nama}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        disabled={busyInboxId === row.id || !pickPerson[row.id]}
                        onClick={() => void matchInboxRow(row)}
                      >
                        Cocokkan
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyInboxId === row.id}
                        onClick={() => void ignoreInboxRow(row)}
                      >
                        Abaikan
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={importOpen} onOpenChange={(o) => {
        setImportOpen(o);
        if (!o) {
          setCsvText('');
          setCsvFileName('');
        }
      }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Impor mutasi BNI</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Unggah CSV Direct BNI (pemisah ; atau ,). Hanya baris debet yang masuk antrian gaji.
            </p>
            <div className="flex items-center gap-2">
              <input
                ref={csvFileRef}
                type="file"
                accept=".csv,text/csv,text/plain"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  void file.text().then((text) => {
                    setCsvText(text);
                    setCsvFileName(file.name);
                  });
                  e.target.value = '';
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => csvFileRef.current?.click()}
              >
                <Upload className="h-4 w-4 mr-1" />
                Pilih file CSV
              </Button>
              {csvFileName && <span className="text-xs text-muted-foreground">{csvFileName}</span>}
            </div>
            <div className="space-y-1">
              <Label>Teks CSV</Label>
              <Textarea
                className="min-h-[180px] font-mono text-xs"
                placeholder={'Tanggal;Keterangan;Debet;Kredit;Saldo;NTB'}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>Batal</Button>
            <Button onClick={() => void importMutasi()} disabled={importing || !csvText.trim()}>
              {importing ? 'Mengimpor…' : 'Impor'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? `Personel ${editing.kode}` : 'Tambah Personel'}</DialogTitle>
          </DialogHeader>
          <Tabs
            value={tab}
            onValueChange={(v) => {
              setTab(v);
              if (v === 'transfer' && editing?.id) void loadPayments(editing.id);
            }}
          >
            <TabsList className="flex flex-wrap h-auto">
              <TabsTrigger value="identitas">Identitas</TabsTrigger>
              <TabsTrigger value="rekening">Rekening</TabsTrigger>
              <TabsTrigger value="lampiran" disabled={!editing?.id}>Lampiran</TabsTrigger>
              <TabsTrigger value="transfer" disabled={!editing?.id}>Transfer gaji</TabsTrigger>
            </TabsList>

            <TabsContent value="identitas" className="space-y-3 py-2">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1 md:col-span-2">
                  <Label>Nama</Label>
                  <Input
                    value={form.nama}
                    onChange={(e) => setForm((f) => ({ ...f, nama: e.target.value }))}
                    placeholder="Nama lengkap"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Jenis</Label>
                  <Select
                    value={form.jenis}
                    onValueChange={(v) => setForm((f) => ({ ...f, jenis: v as KitchenPersonJenis }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(KITCHEN_PERSON_JENIS_LABELS).map(([k, label]) => (
                        <SelectItem key={k} value={k}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Peran</Label>
                  <Select
                    value={form.peran}
                    onValueChange={(v) => setForm((f) => ({ ...f, peran: v as KitchenPersonPeran }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(KITCHEN_PERSON_PERAN_LABELS).map(([k, label]) => (
                        <SelectItem key={k} value={k}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Jabatan</Label>
                  <Input
                    value={form.jabatan}
                    onChange={(e) => setForm((f) => ({ ...f, jabatan: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label>NIK</Label>
                  <Input
                    value={form.nik}
                    onChange={(e) => setForm((f) => ({ ...f, nik: e.target.value }))}
                    placeholder="Kode / nomor identitas"
                    maxLength={64}
                  />
                </div>
                <div className="space-y-1">
                  <Label>No. telp</Label>
                  <Input
                    value={form.noTelp}
                    onChange={(e) => setForm((f) => ({ ...f, noTelp: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Masa tugas mulai</Label>
                  <Input
                    type="date"
                    value={form.effectiveFrom}
                    onChange={(e) => setForm((f) => ({ ...f, effectiveFrom: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Masa tugas selesai</Label>
                  <Input
                    type="date"
                    value={form.effectiveTo}
                    onChange={(e) => setForm((f) => ({ ...f, effectiveTo: e.target.value }))}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Dapur</Label>
                <div className="grid gap-2 sm:grid-cols-2 rounded-md border p-3">
                  {filteredKitchens.length === 0 && (
                    <p className="text-sm text-muted-foreground">Belum ada dapur aktif.</p>
                  )}
                  {filteredKitchens.map((k) => {
                    const checked = form.kitchenIds.includes(k.id);
                    return (
                      <label key={k.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) => setForm((f) => ({
                            ...f,
                            kitchenIds: v
                              ? [...f.kitchenIds, k.id]
                              : f.kitchenIds.filter((id) => id !== k.id),
                          }))}
                        />
                        {k.kode ? `${k.kode} — ${k.nama}` : k.nama}
                      </label>
                    );
                  })}
                </div>
              </div>
              {editing && (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.aktif}
                    onCheckedChange={(v) => setForm((f) => ({ ...f, aktif: v === true }))}
                  />
                  Aktif
                </label>
              )}
            </TabsContent>

            <TabsContent value="rekening" className="space-y-3 py-2">
              <p className="text-sm text-muted-foreground">
                Rekening tujuan transfer gaji — bank personel boleh berbeda dari BNI SPPG.
              </p>
              {form.bankAccounts.map((acc, i) => (
                <div key={i} className="grid gap-2 md:grid-cols-12 rounded-md border p-3">
                  <div className="md:col-span-3 space-y-1">
                    <Label>Bank</Label>
                    <Select
                      value={acc.bankCode}
                      onValueChange={(v) => setForm((f) => {
                        const next = [...f.bankAccounts];
                        next[i] = { ...next[i], bankCode: v as PersonBankCode };
                        return { ...f, bankAccounts: next };
                      })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PERSON_BANK_CATALOG.map((b) => (
                          <SelectItem key={b.code} value={b.code}>{b.nama}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="md:col-span-4 space-y-1">
                    <Label>No. rekening</Label>
                    <Input
                      value={acc.accountNo}
                      onChange={(e) => setForm((f) => {
                        const next = [...f.bankAccounts];
                        next[i] = { ...next[i], accountNo: e.target.value };
                        return { ...f, bankAccounts: next };
                      })}
                      inputMode="numeric"
                    />
                  </div>
                  <div className="md:col-span-3 space-y-1">
                    <Label>Nama rekening</Label>
                    <Input
                      value={acc.accountName}
                      onChange={(e) => setForm((f) => {
                        const next = [...f.bankAccounts];
                        next[i] = { ...next[i], accountName: e.target.value };
                        return { ...f, bankAccounts: next };
                      })}
                    />
                  </div>
                  <div className="md:col-span-2 flex items-end gap-2">
                    <label className="flex items-center gap-1 text-xs">
                      <Checkbox
                        checked={acc.isPrimary}
                        onCheckedChange={(v) => setForm((f) => ({
                          ...f,
                          bankAccounts: f.bankAccounts.map((row, idx) => ({
                            ...row,
                            isPrimary: idx === i ? v === true : false,
                          })),
                        }))}
                      />
                      Utama
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setForm((f) => ({
                        ...f,
                        bankAccounts: f.bankAccounts.filter((_, idx) => idx !== i),
                      }))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setForm((f) => ({
                  ...f,
                  bankAccounts: [
                    ...f.bankAccounts,
                    {
                      bankCode: 'BCA' as PersonBankCode,
                      accountNo: '',
                      accountName: f.nama,
                      isPrimary: f.bankAccounts.length === 0,
                    },
                  ],
                }))}
              >
                <Plus className="h-4 w-4 mr-1" />
                Tambah rekening
              </Button>
            </TabsContent>

            <TabsContent value="lampiran" className="space-y-3 py-2">
              {!editing?.id ? (
                <p className="text-sm text-muted-foreground">Simpan identitas dulu untuk unggah lampiran.</p>
              ) : (
                <>
                  <div className="grid gap-2 md:grid-cols-3">
                    <div className="space-y-1">
                      <Label>Jenis</Label>
                      <Select
                        value={attachKind}
                        onValueChange={(v) => setAttachKind(v as KitchenPersonAttachmentKind)}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {Object.entries(PERSON_ATTACHMENT_KIND_LABELS).map(([k, label]) => (
                            <SelectItem key={k} value={k}>{label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1 md:col-span-2">
                      <Label>Judul (opsional)</Label>
                      <Input
                        value={attachTitle}
                        onChange={(e) => setAttachTitle(e.target.value)}
                        placeholder="KTP, sertifikat higiene, kontrak…"
                      />
                    </div>
                  </div>
                  <div>
                    <input
                      ref={fileRef}
                      type="file"
                      className="hidden"
                      accept={attachKind === 'FOTO' ? 'image/jpeg,image/png,image/webp' : '.pdf,.doc,.docx,.jpg,.jpeg,.png'}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void uploadAttachment(file);
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={uploading}
                      onClick={() => fileRef.current?.click()}
                    >
                      <Upload className="h-4 w-4 mr-1" />
                      {uploading ? 'Mengunggah…' : 'Unggah berkas'}
                    </Button>
                    <p className="text-xs text-muted-foreground mt-1">
                      Foto maks. 1MB (3 berkas). Dokumen PDF/Office/gambar maks. 8MB (20 berkas).
                    </p>
                  </div>
                  <div className="rounded-md border divide-y">
                    {(editing.attachments || []).length === 0 && (
                      <p className="p-3 text-sm text-muted-foreground">Belum ada lampiran.</p>
                    )}
                    {(editing.attachments || []).map((att) => (
                      <div key={att.id} className="flex items-center justify-between gap-2 p-3 text-sm">
                        <div>
                          <div className="font-medium">{att.title}</div>
                          <div className="text-xs text-muted-foreground">
                            {PERSON_ATTACHMENT_KIND_LABELS[att.kind]} · {att.originalName || att.mimeType}
                          </div>
                        </div>
                        <div className="flex gap-1">
                          <Button variant="outline" size="sm" onClick={() => void downloadAttachment(att)}>
                            Unduh
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => void deleteAttachment(att)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </TabsContent>

            <TabsContent value="transfer" className="py-4 space-y-3">
              {editing && Number(editing.paymentCount || 0) > 0 && (
                <p className="text-xs text-muted-foreground">
                  Terakhir dibayar {String(editing.lastPaidAt || '').slice(0, 10) || '—'}
                  {' · '}{formatIDR(editing.lastPaidAmount || 0)}
                  {' · '}{editing.paymentCount} transfer
                </p>
              )}
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Dari</Label>
                  <Input
                    type="date"
                    className="w-40 h-8"
                    value={payFrom}
                    onChange={(e) => setPayFrom(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && editing?.id) void loadPayments(editing.id, 0);
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Sampai</Label>
                  <Input
                    type="date"
                    className="w-40 h-8"
                    value={payTo}
                    onChange={(e) => setPayTo(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && editing?.id) void loadPayments(editing.id, 0);
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Status</Label>
                  <Select
                    value={payStatus}
                    onValueChange={(v) => {
                      setPayStatus(v);
                      if (editing?.id) void loadPayments(editing.id, 0, { status: v });
                    }}
                  >
                    <SelectTrigger className="w-36 h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">Semua</SelectItem>
                      <SelectItem value="POSTED">{PERSON_PAYMENT_STATUS_LABELS.POSTED}</SelectItem>
                      <SelectItem value="DETECTED">{PERSON_PAYMENT_STATUS_LABELS.DETECTED}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!editing?.id || payLoading}
                  onClick={() => editing?.id && void loadPayments(editing.id, 0)}
                >
                  Terapkan
                </Button>
              </div>
              {payments === null && (
                <p className="text-sm text-muted-foreground">Memuat riwayat…</p>
              )}
              {payments && payments.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {payFrom || payTo || payStatus !== 'ALL'
                    ? 'Tidak ada transfer pada filter ini.'
                    : 'Belum ada transfer gaji. Riwayat terisi setelah mutasi BNI tercocokkan.'}
                </p>
              )}
              {payments && payments.length === 0 && (payFrom || payTo || payStatus !== 'ALL') && (
                <p className="text-sm text-muted-foreground">
                  Total periode: {formatIDR(payTotalAmount)} · {payTotal} transaksi
                </p>
              )}
              {payments && payments.length > 0 && (
                <>
                  <p className="text-sm">
                    Total periode: <span className="font-medium">{formatIDR(payTotalAmount)}</span>
                    <span className="text-muted-foreground"> · {payTotal} transaksi</span>
                  </p>
                  <div className="rounded-md border overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="text-left p-2 font-medium">Tanggal</th>
                          <th className="text-left p-2 font-medium">Nominal</th>
                          <th className="text-left p-2 font-medium">Bank tujuan</th>
                          <th className="text-left p-2 font-medium">Norek</th>
                          <th className="text-left p-2 font-medium">NTB</th>
                          <th className="text-left p-2 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {payments.map((p) => (
                          <tr key={p.id} className="border-t">
                            <td className="p-2 whitespace-nowrap">{p.tanggal}</td>
                            <td className="p-2 whitespace-nowrap font-medium">{formatIDR(p.amount)}</td>
                            <td className="p-2">{bankLabel(p.bankCode)}</td>
                            <td className="p-2 font-mono text-xs">{p.accountNo || '—'}</td>
                            <td className="p-2 font-mono text-xs">{p.bankRef}</td>
                            <td className="p-2">{PERSON_PAYMENT_STATUS_LABELS[p.status] || p.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {payHasMore && editing?.id && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={payLoading}
                      onClick={() => void loadPayments(editing.id, payments.length)}
                    >
                      Muat lagi
                    </Button>
                  )}
                </>
              )}
            </TabsContent>
          </Tabs>
          <DialogFooter className="gap-2">
            {editing?.id && (
              <Button variant="outline" className="mr-auto" onClick={() => void deactivate()}>
                Nonaktifkan
              </Button>
            )}
            <Button variant="outline" onClick={() => setOpen(false)}>Tutup</Button>
            <Button onClick={() => void save()} disabled={saving || !form.nama.trim() || !form.nik.trim()}>
              {saving ? 'Menyimpan…' : 'Simpan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
