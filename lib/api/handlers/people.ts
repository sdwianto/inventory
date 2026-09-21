import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  tenantIdForWrite,
  withTenantFilter,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { nextSequentialCode } from '@/lib/api/document-sequence';
import {
  storeBase64Image,
  storeBase64File,
  readMediaFile,
  deleteMediaFile,
} from '@/lib/api/media-storage';
import {
  PEOPLE_COLLECTION,
  PERSON_PAYMENTS_COLLECTION,
  PERSON_CODE_PREFIX,
  PERSON_CODE_DOC_TYPE,
  PERSON_FOTO_MAX_BYTES,
  PERSON_DOC_MAX_BYTES,
  assertBankAccounts,
  assertCanAddAttachment,
  normalizeAttachmentKind,
  normalizeIsoDate,
  normalizeJenis,
  normalizeKitchenIds,
  normalizeNik,
  normalizePeran,
  normalizePersonNama,
  estimateBase64Bytes,
  isFotoMime,
  projectPersonDetail,
  projectPersonList,
  type KitchenPersonAttachment,
  type KitchenPersonDoc,
} from '@/lib/people/person';
import { PEOPLE_MANAGE_ROLES } from '@/lib/people/roles';
import { publicPersonPayment, buildPersonPaymentListQuery, type PersonPaymentDoc } from '@/lib/people/person-payment';
import type { HandlerContext } from '@/types/api/handler';

const MANAGE_ROLES = PEOPLE_MANAGE_ROLES;
const DOC_EXTS = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'] as const;

interface PersonBody extends Record<string, unknown> {
  nama?: string;
  kode?: string;
  jenis?: string;
  peran?: string;
  jabatan?: string;
  nik?: string;
  noTelp?: string;
  kitchenIds?: unknown;
  bankAccounts?: unknown;
  userId?: string;
  aktif?: boolean;
  effectiveFrom?: string;
  effectiveTo?: string;
  kind?: string;
  title?: string;
  originalName?: string;
  dataBase64?: string;
  data?: string;
  issuedAt?: string;
  expiresAt?: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeKode(raw: unknown): string {
  return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
}

function normalizeTelp(raw: unknown): string {
  return String(raw || '').trim().replace(/[^\d+]/g, '');
}

function safeDownloadName(name: string): string {
  const base = String(name || 'lampiran').replace(/[\r\n"]/g, '_').slice(0, 180);
  return base || 'lampiran';
}

function asPerson(doc: Record<string, unknown> | null): KitchenPersonDoc | null {
  if (!doc) return null;
  return {
    ...(doc as unknown as KitchenPersonDoc),
    kitchenIds: Array.isArray(doc.kitchenIds) ? doc.kitchenIds.map(String) : [],
    bankAccounts: Array.isArray(doc.bankAccounts) ? doc.bankAccounts as KitchenPersonDoc['bankAccounts'] : [],
    attachments: Array.isArray(doc.attachments) ? doc.attachments as KitchenPersonAttachment[] : [],
  };
}

async function findPerson(
  db: HandlerContext['db'],
  scopeAuth: NonNullable<ReturnType<typeof resolveOperationalScope>['scopeAuth']>,
  id: string,
): Promise<KitchenPersonDoc | null> {
  const raw = await db.collection(PEOPLE_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { id }),
  );
  return asPerson(raw as Record<string, unknown> | null);
}

async function paymentStats(
  db: HandlerContext['db'],
  scopeAuth: NonNullable<ReturnType<typeof resolveOperationalScope>['scopeAuth']>,
  personId: string,
) {
  const filter = withTenantFilter(scopeAuth, {
    personId,
    status: { $in: ['POSTED', 'DETECTED'] },
  });
  const [agg] = await db.collection(PERSON_PAYMENTS_COLLECTION).aggregate<{
    paymentCount: number;
    lastPaidAt: string | Date | null;
    lastPaidAmount: number;
  }>([
    { $match: filter },
    { $sort: { tanggal: -1, createdAt: -1 } },
    {
      $group: {
        _id: null,
        paymentCount: { $sum: 1 },
        lastPaidAt: { $first: '$tanggal' },
        lastPaidAmount: { $first: '$amount' },
      },
    },
  ]).toArray();
  return {
    paymentCount: Number(agg?.paymentCount || 0),
    lastPaidAt: agg?.lastPaidAt || null,
    lastPaidAmount: Number(agg?.lastPaidAmount || 0),
  };
}

async function assertUniqueNik(
  db: HandlerContext['db'],
  scopeAuth: NonNullable<ReturnType<typeof resolveOperationalScope>['scopeAuth']>,
  nik: string,
  exceptId?: string,
): Promise<string | null> {
  if (!nik) return null;
  const dup = await db.collection(PEOPLE_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { nik, ...(exceptId ? { id: { $ne: exceptId } } : {}) }),
  );
  return dup ? `NIK ${nik} sudah terdaftar` : null;
}

async function assertUniqueKode(
  db: HandlerContext['db'],
  scopeAuth: NonNullable<ReturnType<typeof resolveOperationalScope>['scopeAuth']>,
  kode: string,
  exceptId?: string,
): Promise<string | null> {
  if (!kode) return null;
  const dup = await db.collection(PEOPLE_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { kode, ...(exceptId ? { id: { $ne: exceptId } } : {}) }),
  );
  return dup ? `Kode ${kode} sudah dipakai` : null;
}

async function assertUniqueBanks(
  db: HandlerContext['db'],
  scopeAuth: NonNullable<ReturnType<typeof resolveOperationalScope>['scopeAuth']>,
  accounts: KitchenPersonDoc['bankAccounts'],
  exceptId?: string,
): Promise<string | null> {
  for (const acc of accounts) {
    const dup = await db.collection(PEOPLE_COLLECTION).findOne(
      withTenantFilter(scopeAuth, {
        ...(exceptId ? { id: { $ne: exceptId } } : {}),
        bankAccounts: { $elemMatch: { bankCode: acc.bankCode, accountNo: acc.accountNo } },
      }),
    );
    if (dup) return `Rekening ${acc.bankCode} ${acc.accountNo} sudah dipakai personel lain`;
  }
  return null;
}

function parseMasaTugas(fromRaw: unknown, toRaw: unknown):
  { effectiveFrom?: string; effectiveTo?: string } | { error: string } {
  const effectiveFrom = normalizeIsoDate(fromRaw);
  const effectiveTo = normalizeIsoDate(toRaw);
  if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) {
    return { error: 'Tanggal mulai masa tugas tidak boleh setelah tanggal selesai' };
  }
  return { effectiveFrom, effectiveTo };
}

function isPeopleListRoute(route: string) {
  return route === '/people' || route === '/kitchen-people';
}

function isPeopleRoot(seg: string | undefined) {
  return seg === 'people' || seg === 'kitchen-people';
}

export async function handlePeople({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
  if (deniedRole) return deniedRole;

  const personBody = (body || {}) as PersonBody;
  const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: personBody, request });
  if (denied) return denied;
  if (!scopeAuth) return err('Scope tidak valid', 400);

  if (isPeopleListRoute(route) && method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim();
    const kitchenId = String(url.searchParams.get('kitchenId') || '').trim();
    const jenis = String(url.searchParams.get('jenis') || '').trim().toUpperCase();
    const peran = String(url.searchParams.get('peran') || '').trim().toUpperCase();
    const onlyActive = url.searchParams.get('aktif') === '1';
    let filter: Record<string, unknown> = {};
    if (onlyActive) filter.aktif = true;
    if (kitchenId) filter.kitchenIds = kitchenId;
    if (jenis === 'KARYAWAN' || jenis === 'RELAWAN') filter.jenis = jenis;
    if (peran) filter.peran = peran;
    if (q) {
      const rx = { $regex: escapeRegex(q), $options: 'i' };
      filter.$or = [{ nama: rx }, { kode: rx }, { nik: rx }, { jabatan: rx }];
    }
    filter = withTenantFilter(scopeAuth, filter);
    const list = await db.collection(PEOPLE_COLLECTION).aggregate([
      { $match: filter },
      { $addFields: { attachmentCount: { $size: { $ifNull: ['$attachments', []] } } } },
      { $project: { attachments: 0 } },
      { $sort: { nama: 1 } },
      { $limit: 500 },
    ]).toArray();
    return ok(list.map((doc) => {
      const row = asPerson(doc as Record<string, unknown>)!;
      return clean({
        ...projectPersonList(row),
        attachmentCount: Number((doc as { attachmentCount?: number }).attachmentCount || 0),
      });
    }));
  }

  if (isPeopleListRoute(route) && method === 'POST') {
    const nama = normalizePersonNama(personBody.nama);
    if (!nama) return err('Nama wajib diisi');
    if (!String(personBody.nik || '').trim()) return err('NIK wajib diisi');
    const nik = normalizeNik(personBody.nik);
    if (!nik) return err('NIK terlalu panjang (maks. 64 karakter)');
    const banks = assertBankAccounts(personBody.bankAccounts);
    if ('error' in banks) return err(banks.error);
    const masa = parseMasaTugas(personBody.effectiveFrom, personBody.effectiveTo);
    if ('error' in masa) return err(masa.error);

    const tenantId = tenantIdForWrite(scopeAuth, personBody);
    let kode = normalizeKode(personBody.kode);
    if (!kode) {
      kode = await nextSequentialCode(
        db,
        tenantId,
        PERSON_CODE_DOC_TYPE,
        PERSON_CODE_PREFIX,
        4,
      );
    }
    const kodeErr = await assertUniqueKode(db, scopeAuth, kode);
    if (kodeErr) return err(kodeErr);
    const nikErr = await assertUniqueNik(db, scopeAuth, nik);
    if (nikErr) return err(nikErr);
    const bankErr = await assertUniqueBanks(db, scopeAuth, banks);
    if (bankErr) return err(bankErr);

    const now = new Date();
    const doc: KitchenPersonDoc = {
      id: uuidv4(),
      tenantId,
      kode,
      nama,
      jenis: normalizeJenis(personBody.jenis),
      peran: normalizePeran(personBody.peran),
      jabatan: normalizePersonNama(personBody.jabatan) || undefined,
      nik,
      noTelp: normalizeTelp(personBody.noTelp) || undefined,
      kitchenIds: normalizeKitchenIds(personBody.kitchenIds),
      bankAccounts: banks,
      userId: String(personBody.userId || '').trim() || undefined,
      aktif: personBody.aktif !== false,
      effectiveFrom: masa.effectiveFrom,
      effectiveTo: masa.effectiveTo,
      attachments: [],
      createdAt: now,
      updatedAt: now,
    };
    await db.collection(PEOPLE_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'PERSON_CREATE',
      entityType: 'person',
      entityId: doc.id,
      summary: `Personel ${doc.nama} (${doc.kode}) dibuat`,
      ...auditActor(auth),
    });
    return ok(clean(projectPersonDetail(doc)));
  }

  if (!isPeopleRoot(path[0]) || !path[1]) return null;
  const id = path[1];

  if (path[2] === 'payments' && method === 'GET') {
    const existing = await findPerson(db, scopeAuth, id);
    if (!existing) return err('Personel tidak ditemukan', 404);

    const parsed = buildPersonPaymentListQuery({
      personId: id,
      from: url.searchParams.get('from') || '',
      to: url.searchParams.get('to') || '',
      status: url.searchParams.get('status') || '',
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset'),
    });
    if ('error' in parsed) return err(parsed.error);

    const matched = withTenantFilter(scopeAuth, parsed.filter);
    const col = db.collection(PERSON_PAYMENTS_COLLECTION);
    const [rows, total, summed] = await Promise.all([
      col.find(matched).sort({ tanggal: -1, createdAt: -1 }).skip(parsed.offset).limit(parsed.limit).toArray(),
      col.countDocuments(matched),
      col.aggregate<{ totalAmount: number }>([
        { $match: matched },
        { $group: { _id: null, totalAmount: { $sum: '$amount' } } },
      ]).toArray(),
    ]);
    const items = rows.map((doc) => clean(publicPersonPayment(doc as unknown as PersonPaymentDoc)));
    return ok({
      items,
      total,
      totalAmount: Number(summed[0]?.totalAmount || 0),
      limit: parsed.limit,
      offset: parsed.offset,
      hasMore: parsed.offset + items.length < total,
    });
  }

  if (path[2] === 'attachments' && method === 'POST' && !path[3]) {
    const existing = await findPerson(db, scopeAuth, id);
    if (!existing) return err('Personel tidak ditemukan', 404);
    const kind = normalizeAttachmentKind(personBody.kind);
    if (!kind) return err('Jenis lampiran tidak valid');
    const cap = assertCanAddAttachment(existing.attachments, kind);
    if (cap) return err(cap);
    const title = normalizePersonNama(personBody.title) || kind;
    const originalName = String(personBody.originalName || '').trim() || undefined;
    const data = String(personBody.dataBase64 || personBody.data || '').trim();
    if (!data) return err('Berkas lampiran wajib');
    const issuedAt = normalizeIsoDate(personBody.issuedAt);
    const expiresAt = normalizeIsoDate(personBody.expiresAt);
    const mimeHint = /^data:([^;]+);/i.exec(data)?.[1]?.toLowerCase() || '';
    if (kind === 'FOTO' && mimeHint && !isFotoMime(mimeHint)) {
      return err('Foto wajib jpeg, png, atau webp');
    }

    let stored: { filename: string; mimeType?: string; sizeBytes?: number } | { error: string };
    if (kind === 'FOTO') {
      const img = await storeBase64Image(existing.tenantId, data, {
        prefix: 'kdp',
        maxBytes: PERSON_FOTO_MAX_BYTES,
      });
      stored = img;
    } else {
      stored = await storeBase64File(existing.tenantId, data, {
        prefix: 'kdp',
        maxBytes: PERSON_DOC_MAX_BYTES,
        allowedExts: DOC_EXTS,
        originalName,
      });
    }
    if ('error' in stored) return err(stored.error);

    const storedExt = stored.filename.split('.').pop()?.toLowerCase() || '';
    if (kind === 'FOTO' && (storedExt === 'gif' || mimeHint === 'image/gif')) {
      await deleteMediaFile(existing.tenantId, stored.filename);
      return err('Foto wajib jpeg, png, atau webp');
    }
    const storedMime = ('mimeType' in stored && stored.mimeType)
      || (storedExt === 'png' ? 'image/png'
        : storedExt === 'webp' ? 'image/webp'
        : storedExt === 'jpg' || storedExt === 'jpeg' ? 'image/jpeg'
        : kind === 'FOTO'
          ? (isFotoMime(mimeHint) ? (mimeHint === 'image/jpg' ? 'image/jpeg' : mimeHint) : 'image/jpeg')
          : 'application/octet-stream');

    const att: KitchenPersonAttachment = {
      id: uuidv4(),
      kind,
      title,
      originalName,
      filename: stored.filename,
      mimeType: storedMime,
      sizeBytes: ('sizeBytes' in stored && stored.sizeBytes) || estimateBase64Bytes(data),
      issuedAt,
      expiresAt,
      uploadedAt: new Date(),
      uploadedBy: auth?.userId,
      uploadedByName: auth?.name || auth?.email,
    };
    await db.collection(PEOPLE_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { attachments: [...existing.attachments, att], updatedAt: new Date() } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'PERSON_ATTACHMENT_ADD',
      entityType: 'person',
      entityId: id,
      summary: `Lampiran ${kind} ditambah untuk ${existing.nama}`,
      ...auditActor(auth),
    });
    const saved = await findPerson(db, scopeAuth, id);
    const pay = await paymentStats(db, scopeAuth, id);
    return ok(clean(projectPersonDetail(saved!, pay)));
  }

  if (path[2] === 'attachments' && path[3] && method === 'GET') {
    const existing = await findPerson(db, scopeAuth, id);
    if (!existing) return err('Personel tidak ditemukan', 404);
    const att = existing.attachments.find((a) => a.id === path[3]);
    if (!att?.filename) return err('Lampiran tidak ditemukan', 404);
    try {
      const buf = await readMediaFile(existing.tenantId, att.filename);
      const downloadName = safeDownloadName(att.originalName || att.title);
      const inline = att.mimeType.startsWith('image/') || att.mimeType === 'application/pdf';
      return new Response(buf, {
        status: 200,
        headers: {
          'Content-Type': att.mimeType || 'application/octet-stream',
          'Content-Disposition': inline
            ? `inline; filename="${downloadName}"`
            : `attachment; filename="${downloadName}"`,
          'Cache-Control': 'private, no-store',
        },
      }) as unknown as NextResponse;
    } catch {
      return err('Berkas tidak ditemukan', 404);
    }
  }

  if (path[2] === 'attachments' && path[3] && method === 'DELETE') {
    const existing = await findPerson(db, scopeAuth, id);
    if (!existing) return err('Personel tidak ditemukan', 404);
    const att = existing.attachments.find((a) => a.id === path[3]);
    if (!att) return err('Lampiran tidak ditemukan', 404);
    await db.collection(PEOPLE_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      {
        $set: {
          attachments: existing.attachments.filter((a) => a.id !== att.id),
          updatedAt: new Date(),
        },
      },
    );
    await deleteMediaFile(existing.tenantId, att.filename);
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'PERSON_ATTACHMENT_REMOVE',
      entityType: 'person',
      entityId: id,
      summary: `Lampiran ${att.kind} dihapus dari ${existing.nama}`,
      ...auditActor(auth),
    });
    const saved = await findPerson(db, scopeAuth, id);
    const pay = await paymentStats(db, scopeAuth, id);
    return ok(clean(projectPersonDetail(saved!, pay)));
  }

  if (path[2]) return null;

  if (method === 'GET') {
    const existing = await findPerson(db, scopeAuth, id);
    if (!existing) return err('Personel tidak ditemukan', 404);
    const pay = await paymentStats(db, scopeAuth, id);
    return ok(clean(projectPersonDetail(existing, pay)));
  }

  if (method === 'PUT') {
    const existing = await findPerson(db, scopeAuth, id);
    if (!existing) return err('Personel tidak ditemukan', 404);
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (personBody.nama !== undefined) {
      const nama = normalizePersonNama(personBody.nama);
      if (!nama) return err('Nama wajib diisi');
      update.nama = nama;
    }
    if (personBody.jenis !== undefined) update.jenis = normalizeJenis(personBody.jenis);
    if (personBody.peran !== undefined) update.peran = normalizePeran(personBody.peran);
    if (personBody.jabatan !== undefined) {
      update.jabatan = normalizePersonNama(personBody.jabatan) || null;
    }
    if (personBody.nik !== undefined) {
      if (!String(personBody.nik || '').trim()) return err('NIK wajib diisi');
      const nik = normalizeNik(personBody.nik);
      if (!nik) return err('NIK terlalu panjang (maks. 64 karakter)');
      const nikErr = await assertUniqueNik(db, scopeAuth, nik, id);
      if (nikErr) return err(nikErr);
      update.nik = nik;
    }
    if (personBody.noTelp !== undefined) update.noTelp = normalizeTelp(personBody.noTelp) || null;
    if (personBody.kitchenIds !== undefined) update.kitchenIds = normalizeKitchenIds(personBody.kitchenIds);
    if (personBody.bankAccounts !== undefined) {
      const banks = assertBankAccounts(personBody.bankAccounts);
      if ('error' in banks) return err(banks.error);
      const bankErr = await assertUniqueBanks(db, scopeAuth, banks, id);
      if (bankErr) return err(bankErr);
      update.bankAccounts = banks;
    }
    if (personBody.userId !== undefined) update.userId = String(personBody.userId || '').trim() || null;
    if (personBody.aktif !== undefined) update.aktif = !!personBody.aktif;
    if (personBody.kode !== undefined) {
      const kode = normalizeKode(personBody.kode);
      if (kode) {
        const kodeErr = await assertUniqueKode(db, scopeAuth, kode, id);
        if (kodeErr) return err(kodeErr);
      }
      update.kode = kode || existing.kode;
    }
    if (personBody.effectiveFrom !== undefined || personBody.effectiveTo !== undefined) {
      const masa = parseMasaTugas(
        personBody.effectiveFrom !== undefined ? personBody.effectiveFrom : existing.effectiveFrom,
        personBody.effectiveTo !== undefined ? personBody.effectiveTo : existing.effectiveTo,
      );
      if ('error' in masa) return err(masa.error);
      update.effectiveFrom = masa.effectiveFrom || null;
      update.effectiveTo = masa.effectiveTo || null;
    }

    const goingInactive = personBody.aktif === false && existing.aktif !== false;
    await db.collection(PEOPLE_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: update },
    );
    const saved = await findPerson(db, scopeAuth, id);
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: goingInactive ? 'PERSON_DEACTIVATE' : 'PERSON_UPDATE',
      entityType: 'person',
      entityId: id,
      summary: goingInactive
        ? `Personel ${saved?.nama || existing.nama} dinonaktifkan`
        : `Personel ${saved?.nama || existing.nama} diubah`,
      ...auditActor(auth),
    });
    const pay = await paymentStats(db, scopeAuth, id);
    return ok(clean(projectPersonDetail(saved!, pay)));
  }

  if (method === 'DELETE') {
    const existing = await findPerson(db, scopeAuth, id);
    if (!existing) return err('Personel tidak ditemukan', 404);
    await db.collection(PEOPLE_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { aktif: false, updatedAt: new Date() } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'PERSON_DEACTIVATE',
      entityType: 'person',
      entityId: id,
      summary: `Personel ${existing.nama} dinonaktifkan`,
      ...auditActor(auth),
    });
    return ok({ id, aktif: false });
  }

  return null;
}

