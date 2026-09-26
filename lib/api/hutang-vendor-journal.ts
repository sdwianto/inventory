import type { ClientSession, Db } from 'mongodb';
// Siklus jurnal AUTO_HUTANG_VENDOR: posting saat MATCHED / approve override, void saat tolak atau
// saat sinkron ulang membuat tagihan jadi EXCEPTION atau nilainya berubah.

import { createJournal, createJournalIfNotExists } from '@/lib/api/journal';
import { COA, buildVendorHutangJournalLines, reverseJournalDetails } from '@/lib/api/journal-lines';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import { txOpts } from '@/lib/api/transaction';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { idInTenant } from '@/lib/api/doc-filter';
import { hutangVendorKey } from '@/lib/api/hutang-vendor-match';
import type { JournalDetail } from '@/types/finance';

export const HUTANG_VENDOR_SOURCE = 'AUTO_HUTANG_VENDOR';
export const HUTANG_VENDOR_VOID_SOURCE = 'AUTO_HUTANG_VENDOR_VOID';

export type HutangPostingBase = { subTotal: number; ppn: number; total: number };

type HutangLike = {
  id?: unknown;
  tenantId?: unknown;
  noInvoice?: unknown;
  noHutang?: unknown;
  noDO?: unknown;
  vendorTenantId?: unknown;
  vendorInvoiceId?: unknown;
  tanggal?: unknown;
  total?: unknown;
  ppn?: unknown;
  glPostingBase?: unknown;
  debitNotes?: unknown;
};

type JournalRow = { id: string; details?: JournalDetail[]; totalDebet?: number; voidedAt?: unknown };

function toInt(v: unknown): number {
  return parseInt(String(v ?? 0), 10) || 0;
}

export function buildHutangPostingBase(total: number, ppn: number): HutangPostingBase {
  const t = Math.max(0, Math.round(total));
  const p = Math.max(0, Math.min(t, Math.round(ppn)));
  return { subTotal: t - p, ppn: p, total: t };
}

/**
 * Nilai invoice yang dijurnal AUTO_HUTANG_VENDOR. Debit note menaikkan hutang.total dan punya
 * jurnal sendiri (AUTO_DN_VENDOR), jadi tidak ikut di sini.
 */
export function vendorHutangPostingBase(hutang: HutangLike): HutangPostingBase {
  const stored = hutang.glPostingBase as Partial<HutangPostingBase> | undefined;
  if (stored && toInt(stored.total) > 0) {
    return buildHutangPostingBase(toInt(stored.total), toInt(stored.ppn));
  }
  const dnTotal = (Array.isArray(hutang.debitNotes) ? hutang.debitNotes : [])
    .reduce((s: number, n: { amount?: unknown }) => s + toInt(n?.amount), 0);
  return buildHutangPostingBase(toInt(hutang.total) - dnTotal, toInt(hutang.ppn));
}

/**
 * Jurnal AUTO_HUTANG_VENDOR yang masih berlaku. Void baru menandai voidedAt; void lama
 * (AUTO_HUTANG_VENDOR_VOID tanpa voidOfJournalId) menetralkan satu posting lama.
 */
export async function findActiveVendorHutangJournal(
  db: Db,
  tenantId: string,
  hutangId: string,
  session?: ClientSession,
): Promise<JournalRow | null> {
  const postings = await db.collection('jurnal')
    .find({ tenantId, sourceType: HUTANG_VENDOR_SOURCE, sourceId: hutangId, voidedAt: { $exists: false } }, txOpts(session))
    .sort({ createdAt: 1 })
    .toArray() as unknown as JournalRow[];
  if (!postings.length) return null;
  const legacyVoids = await db.collection('jurnal').countDocuments(
    { tenantId, sourceType: HUTANG_VENDOR_VOID_SOURCE, sourceId: hutangId, voidOfJournalId: { $exists: false } },
    txOpts(session),
  );
  if (postings.length <= legacyVoids) return null;
  return postings[postings.length - 1];
}

async function resolveJournalDate(db: Db, tenantId: string, preferred: Date, session?: ClientSession): Promise<Date> {
  const settings = await db.collection('tenant_settings').findOne({ tenantId }, txOpts(session));
  if (!settings?.periodLockedUntil) return preferred;
  const lockUntil = new Date(String(settings.periodLockedUntil));
  if (Number.isNaN(lockUntil.getTime()) || preferred.getTime() > lockUntil.getTime()) return preferred;
  return new Date();
}

/**
 * Σ akrual GRN (Cr GRNI) milik tagihan ini, atau null bila belum ada yang diakrualkan. GRN milik tagihan:
 * sudah ter-link (hutangId / vendorInvoiceId), atau POSTED belum ter-link dengan DO + vendor yang sama
 * (link ditulis sesudah jurnal saat tagihan dibuat). noDO saja tidak unik: tiap vendor punya urutan sendiri.
 */
export async function findGrnAccrualAmount(db: Db, hutang: HutangLike, session?: ClientSession): Promise<number | null> {
  const tenantId = String(hutang.tenantId || 'default');
  const hutangId = String(hutang.id || '');
  const invoiceId = String(hutang.vendorInvoiceId || '');
  const noDO = String(hutang.noDO || '');
  const findIds = async (clause: Record<string, unknown>) => (await db.collection('goods_receipts')
    .find({ $and: [tenantIdMatchFilter(tenantId), { status: 'POSTED' }, clause] }, { projection: { id: 1 }, ...txOpts(session) })
    .toArray()).map((g) => String(g.id || '')).filter(Boolean);
  const linked: Record<string, unknown>[] = [];
  if (hutangId) linked.push({ hutangId });
  if (invoiceId) linked.push({ vendorInvoiceId: invoiceId });
  let ids = linked.length ? await findIds({ $or: linked }) : [];
  if (!ids.length && noDO) {
    const vid = hutangVendorKey(hutang.vendorTenantId as string | undefined);
    ids = await findIds({
      noDO,
      ...(vid ? { vendorTenantId: vid } : {}),
      $and: [
        { $or: [{ hutangId: { $exists: false } }, { hutangId: null }, { hutangId: '' }] },
        { $or: [{ vendorInvoiceId: { $exists: false } }, { vendorInvoiceId: null }, { vendorInvoiceId: '' }] },
      ],
    });
  }
  if (!ids.length) return null;
  const accruals = await db.collection('jurnal')
    .find({ tenantId, sourceType: 'AUTO_GRN_ACCRUAL', sourceId: { $in: ids } }, txOpts(session))
    .toArray() as unknown as Array<{ details?: JournalDetail[] }>;
  if (!accruals.length) return null;
  return accruals
    .flatMap((a) => a.details || [])
    .filter((d) => d.rekeningKode === COA.GRNI.kode)
    .reduce((s, d) => s + (Number(d.kredit) || 0) - (Number(d.debet) || 0), 0);
}

/** Posting jurnal tagihan bila belum ada yang berlaku. */
export async function postVendorHutangJournal(
  db: Db,
  hutang: HutangLike,
  { userName, keterangan }: { userName: string; keterangan?: string },
  session?: ClientSession,
): Promise<'posted' | 'exists' | 'skipped'> {
  const tenantId = String(hutang.tenantId || 'default');
  const hutangId = String(hutang.id || '');
  if (!hutangId) return 'skipped';
  if (await findActiveVendorHutangJournal(db, tenantId, hutangId, session)) return 'exists';
  const base = vendorHutangPostingBase(hutang);
  if (base.total <= 0) return 'skipped';
  const noDoc = String(hutang.noInvoice || hutang.noHutang || '');
  const preferred = hutang.tanggal ? new Date(hutang.tanggal as string | Date) : new Date();
  const tanggal = await resolveJournalDate(
    db,
    tenantId,
    Number.isNaN(preferred.getTime()) ? new Date() : preferred,
    session,
  );
  const grniAmount = await findGrnAccrualAmount(db, hutang, session);
  // costingV2: tagihan sebelum akrual mendebit GRNI (bukan Persediaan) agar akrual GRN berikutnya
  // tidak menggandakan Persediaan; selisih harga tertinggal di GRNI untuk rekonsiliasi.
  const costingV2 = await isTenantFeatureEnabled(db, tenantId, 'costingV2');
  await createJournal(db, {
    tanggal,
    keterangan: keterangan || `Tagihan vendor ${noDoc}`,
    sourceType: HUTANG_VENDOR_SOURCE,
    sourceId: hutangId,
    userName,
    details: buildVendorHutangJournalLines({
      noDoc,
      subTotal: base.subTotal,
      ppn: base.ppn,
      total: base.total,
      clearGrni: grniAmount != null || costingV2,
      ...(costingV2 && grniAmount != null ? { grniAmount } : {}),
    }),
    tenantId,
  }, session);
  await postDeferredVendorNoteJournals(db, tenantId, hutangId, session);
  return 'posted';
}

/** Balik jurnal tagihan yang berlaku (bila ada). */
export async function voidVendorHutangJournal(
  db: Db,
  hutang: HutangLike,
  { userName, keterangan }: { userName: string; keterangan: string },
  session?: ClientSession,
): Promise<boolean> {
  const tenantId = String(hutang.tenantId || 'default');
  const hutangId = String(hutang.id || '');
  if (!hutangId) return false;
  const active = await findActiveVendorHutangJournal(db, tenantId, hutangId, session);
  if (!active?.details?.length) return false;
  const now = new Date();
  const marked = await db.collection('jurnal').updateOne(
    idInTenant(active.id, tenantId, { voidedAt: { $exists: false } }),
    { $set: { voidedAt: now, voidReason: keterangan } },
    txOpts(session),
  );
  if (marked.matchedCount === 0) return false;
  const reversal = await createJournal(db, {
    tanggal: await resolveJournalDate(db, tenantId, now, session),
    keterangan,
    sourceType: HUTANG_VENDOR_VOID_SOURCE,
    sourceId: hutangId,
    details: reverseJournalDetails(active.details),
    userName,
    tenantId,
  }, session);
  await db.collection('jurnal').updateOne(
    idInTenant(reversal.id, tenantId),
    { $set: { voidOfJournalId: active.id } },
    txOpts(session),
  );
  await voidVendorNoteJournals(db, tenantId, hutangId, { userName, keterangan }, session);
  return true;
}

export type VendorNoteJournalSource = 'AUTO_CN_VENDOR' | 'AUTO_DN_VENDOR';

export type VendorNoteJournal = {
  sourceType: VendorNoteJournalSource;
  sourceId: string;
  keterangan: string;
  userName: string;
  details: JournalDetail[];
  tanggal?: Date;
};

type PostedNoteJournal = { journalId: string; sourceType: VendorNoteJournalSource; sourceId: string };

async function postNoteJournal(
  db: Db,
  tenantId: string,
  hutangId: string,
  journal: VendorNoteJournal,
  session?: ClientSession,
): Promise<void> {
  let sourceId = journal.sourceId;
  const priorVoided = await db.collection('jurnal').countDocuments(
    { tenantId, sourceType: journal.sourceType, sourceId: { $regex: `^${sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(#\\d+)?$` }, voidedAt: { $exists: true } },
    txOpts(session),
  );
  if (priorVoided > 0) sourceId = `${journal.sourceId}#${priorVoided + 1}`;
  const entry = await createJournalIfNotExists(db, {
    tanggal: journal.tanggal ?? await resolveJournalDate(db, tenantId, new Date(), session),
    keterangan: journal.keterangan,
    sourceType: journal.sourceType,
    sourceId,
    userName: journal.userName,
    details: journal.details,
    tenantId,
  }, session);
  if (!entry) return;
  const posted: PostedNoteJournal = { journalId: String(entry.id), sourceType: journal.sourceType, sourceId };
  await db.collection('hutang').updateOne(
    idInTenant(hutangId, tenantId),
    { $addToSet: { postedNoteJournals: posted } } as never,
    txOpts(session),
  );
}

/**
 * Jurnal credit/debit note vendor hanya berlaku bila jurnal tagihannya berlaku. Tagihan EXCEPTION /
 * belum dijurnal: jurnal catatan ditunda dan diposting saat tagihan dijurnal (approve / MATCHED).
 */
export async function postOrDeferNoteJournal(
  db: Db,
  session: ClientSession | undefined,
  input: { tenantId: string; hutangId: string; journal: VendorNoteJournal },
): Promise<'posted' | 'deferred'> {
  if (!(await findActiveVendorHutangJournal(db, input.tenantId, input.hutangId, session))) {
    const { tanggal: _tanggal, ...deferred } = input.journal;
    void _tanggal;
    await db.collection('hutang').updateOne(
      idInTenant(input.hutangId, input.tenantId),
      { $push: { deferredNoteJournals: deferred } } as never,
      txOpts(session),
    );
    return 'deferred';
  }
  await postNoteJournal(db, input.tenantId, input.hutangId, input.journal, session);
  return 'posted';
}

export async function postDeferredVendorNoteJournals(
  db: Db,
  tenantId: string,
  hutangId: string,
  session?: ClientSession,
): Promise<number> {
  const row = await db.collection('hutang').findOne(
    idInTenant(hutangId, tenantId),
    { projection: { deferredNoteJournals: 1 }, ...txOpts(session) },
  ) as { deferredNoteJournals?: VendorNoteJournal[] } | null;
  const list = Array.isArray(row?.deferredNoteJournals) ? row.deferredNoteJournals : [];
  if (!list.length) return 0;
  for (const j of list) await postNoteJournal(db, tenantId, hutangId, j, session);
  await db.collection('hutang').updateOne(idInTenant(hutangId, tenantId), { $unset: { deferredNoteJournals: '' } }, txOpts(session));
  return list.length;
}

/** Balik jurnal credit/debit note yang berlaku; dikembalikan ke daftar tunda untuk dijurnal ulang bila tagihan dijurnal lagi. */
export async function voidVendorNoteJournals(
  db: Db,
  tenantId: string,
  hutangId: string,
  { userName, keterangan }: { userName: string; keterangan: string },
  session?: ClientSession,
): Promise<number> {
  const row = await db.collection('hutang').findOne(
    idInTenant(hutangId, tenantId),
    { projection: { postedNoteJournals: 1, creditNotes: 1, debitNotes: 1 }, ...txOpts(session) },
  ) as {
    postedNoteJournals?: PostedNoteJournal[];
    creditNotes?: Array<{ creditNoteId?: string; noCN?: string }>;
    debitNotes?: Array<{ debitNoteId?: string; noDN?: string }>;
  } | null;
  if (!row) return 0;
  const legacyRefs: Array<{ sourceType: VendorNoteJournalSource; sourceId: string }> = [
    ...(row.creditNotes || []).map((n) => ({ sourceType: 'AUTO_CN_VENDOR' as const, sourceId: String(n.creditNoteId || n.noCN || '') })),
    ...(row.debitNotes || []).map((n) => ({ sourceType: 'AUTO_DN_VENDOR' as const, sourceId: String(n.debitNoteId || n.noDN || '') })),
  ].filter((r) => r.sourceId);
  const refs = [
    ...(row.postedNoteJournals || []).map((p) => ({ id: p.journalId })),
    ...legacyRefs.map((r) => ({ sourceType: r.sourceType, sourceId: r.sourceId })),
  ];
  if (!refs.length) return 0;
  const journals = await db.collection('jurnal').find(
    { tenantId, voidedAt: { $exists: false }, $or: refs },
    txOpts(session),
  ).toArray() as unknown as Array<JournalRow & { sourceType: VendorNoteJournalSource; sourceId: string; keterangan?: string; userName?: string }>;
  const now = new Date();
  const redeferred: VendorNoteJournal[] = [];
  for (const j of journals) {
    if (!j.details?.length) continue;
    const marked = await db.collection('jurnal').updateOne(
      idInTenant(j.id, tenantId, { voidedAt: { $exists: false } }),
      { $set: { voidedAt: now, voidReason: keterangan } },
      txOpts(session),
    );
    if (marked.matchedCount === 0) continue;
    const reversal = await createJournal(db, {
      tanggal: await resolveJournalDate(db, tenantId, now, session),
      keterangan: `${keterangan} — ${j.keterangan || j.sourceType}`,
      sourceType: `${j.sourceType}_VOID`,
      sourceId: j.sourceId,
      details: reverseJournalDetails(j.details),
      userName,
      tenantId,
    }, session);
    await db.collection('jurnal').updateOne(idInTenant(reversal.id, tenantId), { $set: { voidOfJournalId: j.id } }, txOpts(session));
    redeferred.push({
      sourceType: j.sourceType,
      sourceId: String(j.sourceId).replace(/#\d+$/, ''),
      keterangan: String(j.keterangan || j.sourceType),
      userName: String(j.userName || 'System'),
      details: j.details,
    });
  }
  await db.collection('hutang').updateOne(
    idInTenant(hutangId, tenantId),
    {
      $set: { postedNoteJournals: [] },
      ...(redeferred.length ? { $push: { deferredNoteJournals: { $each: redeferred } } } : {}),
    } as never,
    txOpts(session),
  );
  return redeferred.length;
}

/** Jurnal berlaku harus sama dengan nilai tagihan sekarang. */
export function journalMatchesBase(journal: JournalRow, base: HutangPostingBase): boolean {
  const hutangLines = (journal.details || []).filter((d) => d.rekeningKode === COA.HUTANG.kode);
  if (!hutangLines.length) return toInt(journal.totalDebet) === base.total;
  return hutangLines.reduce((s, d) => s + toInt(d.kredit) - toInt(d.debet), 0) === base.total;
}
