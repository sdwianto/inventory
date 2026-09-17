/**
 * Meeting Record API — list/create/update MoM + suggest/upsert topics.
 * Routes: /meeting-records | /meeting-records/:id | /meeting-topics
 */

import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { ok, err, clean } from '@/lib/api/db';
import { requireRole } from '@/lib/api/require-auth';
import { tenantIdForWrite, withTenantFilter, resolveOperationalScope } from '@/lib/api/tenant-master';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { storeBase64Image, storeBase64File, extFromFileName } from '@/lib/api/media-storage';
import { KA_OPS_WRITE_ROLES } from '@/lib/kitchen-assurance/roles';
import { resolveKitchenNama } from '@/lib/kitchen-assurance/auto-issue';
import {
  MEETING_RECORDS_COLLECTION,
  MEETING_TOPICS_COLLECTION,
  MEETING_RECORD_DOC_TYPE,
  MEETING_RECORD_PREFIX,
  MAX_MEETING_PHOTOS,
  MEETING_MATERIAL_FILE_EXTS,
  normalizeMeetingLabel,
  normalizeMeetingLabelKey,
  isMeetingRecordStatus,
  parseAttendees,
  parseActionItems,
  parseMeetingMaterials,
  countOpenActionItems,
  maxBytesForMaterialExt,
  type MeetingRecordDoc,
  type MeetingTopicDoc,
  type MeetingRecordStatus,
  type MeetingMaterial,
} from '@/lib/kitchen-assurance/meeting-record';
import type { HandlerContext } from '@/types/api/handler';
import type { AuthContext } from '@/types/auth';

async function ensureMeetingIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection(MEETING_RECORDS_COLLECTION).createIndex(
      { tenantId: 1, noDokumen: 1 },
      { unique: true, name: 'meeting_records_tenant_no' },
    ),
    db.collection(MEETING_RECORDS_COLLECTION).createIndex(
      { tenantId: 1, meetingAt: -1 },
      { name: 'meeting_records_tenant_meetingAt' },
    ),
    db.collection(MEETING_RECORDS_COLLECTION).createIndex(
      { tenantId: 1, topicId: 1 },
      { name: 'meeting_records_tenant_topic' },
    ),
    db.collection(MEETING_TOPICS_COLLECTION).createIndex(
      { tenantId: 1, namaNorm: 1 },
      { unique: true, name: 'meeting_topics_tenant_namaNorm' },
    ),
  ]).catch(() => { /* index may already exist */ });
}

function actorName(auth: AuthContext | null | undefined): string | undefined {
  return auth?.name || auth?.email || undefined;
}

function canEditFinal(auth: HandlerContext['auth']): boolean {
  const role = String(auth?.role || '').toUpperCase();
  return role === 'ADMIN' || role === 'OWNER' || role === 'MASTER' || Boolean(auth?.isMaster);
}

function normalizeRecord(d: Record<string, unknown>) {
  const items = Array.isArray(d.actionItems) ? d.actionItems : [];
  const materials = Array.isArray(d.materials) ? d.materials : [];
  const photos = Array.isArray(d.photos) ? d.photos : [];
  return clean({
    ...d,
    actionItems: items,
    materials,
    photos,
    actionOpenCount: countOpenActionItems(items as MeetingRecordDoc['actionItems']),
    actionTotalCount: items.length,
    photoCount: photos.length,
    materialCount: materials.length,
  });
}

async function persistMeetingPhotos(
  tenantId: string,
  urls: unknown,
): Promise<string[] | { error: string }> {
  if (urls == null) return [];
  if (!Array.isArray(urls)) return { error: 'Format foto tidak valid' };
  const out: string[] = [];
  for (const raw of urls) {
    const s = String(raw || '').trim();
    if (!s) continue;
    if (s.startsWith('/api/media/') || s.startsWith('http://') || s.startsWith('https://')) {
      out.push(s);
      continue;
    }
    if (s.startsWith('data:') || /^[A-Za-z0-9+/=]+$/.test(s.slice(0, 80))) {
      const stored = await storeBase64Image(tenantId, s, { prefix: 'mom', maxBytes: 768_000 });
      if ('error' in stored) return { error: stored.error };
      out.push(stored.url);
      continue;
    }
    out.push(s);
  }
  if (out.length > MAX_MEETING_PHOTOS) {
    return { error: `Maksimal ${MAX_MEETING_PHOTOS} foto` };
  }
  return out;
}

async function persistMeetingMaterials(
  tenantId: string,
  raw: unknown,
): Promise<MeetingMaterial[] | { error: string }> {
  const parsed = parseMeetingMaterials(raw);
  if ('error' in parsed) return parsed;

  const out: MeetingMaterial[] = [];
  for (const mat of parsed) {
    if (mat.kind === 'LINK') {
      out.push({ ...mat, id: mat.id.startsWith('mat-') ? uuidv4() : mat.id });
      continue;
    }

    const url = mat.url;
    if (
      url.startsWith('/api/media/')
      || url.startsWith('http://')
      || url.startsWith('https://')
    ) {
      out.push({
        ...mat,
        id: mat.id.startsWith('mat-') ? uuidv4() : mat.id,
      });
      continue;
    }

    if (url.startsWith('data:') || /^[A-Za-z0-9+/=]+$/.test(url.slice(0, 80))) {
      const mimeFromData = /^data:([^;]+);/i.exec(url)?.[1]?.toLowerCase() || '';
      const extHint = extFromFileName(mat.originalName || mat.title || '')
        || (mimeFromData.includes('pdf') ? 'pdf'
          : mimeFromData.includes('mp4') ? 'mp4'
            : mimeFromData.includes('webm') ? 'webm'
              : mimeFromData.includes('png') ? 'png'
                : mimeFromData.includes('jpeg') || mimeFromData.includes('jpg') ? 'jpg'
                  : '');
      const maxBytes = maxBytesForMaterialExt(extHint || 'pdf');
      const stored = await storeBase64File(tenantId, url, {
        prefix: 'mom-mat',
        maxBytes,
        allowedExts: MEETING_MATERIAL_FILE_EXTS,
        originalName: mat.originalName || mat.title || (extHint ? `file.${extHint}` : undefined),
      });
      if ('error' in stored) return { error: stored.error };
      out.push({
        id: mat.id.startsWith('mat-') ? uuidv4() : mat.id,
        kind: 'FILE',
        title: mat.title || mat.originalName || stored.filename,
        url: stored.url,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        originalName: mat.originalName || stored.filename,
      });
      continue;
    }

    return { error: `Bahan file "${mat.title}" tidak valid` };
  }
  return out;
}

async function upsertMeetingTopic(
  db: Db,
  tenantId: string,
  namaRaw: string,
  actor: { userId?: string; userName?: string },
): Promise<MeetingTopicDoc | { error: string }> {
  const nama = normalizeMeetingLabel(namaRaw);
  if (!nama) return { error: 'Kategori / Topik Meeting wajib diisi' };
  const namaNorm = normalizeMeetingLabelKey(nama);
  const now = new Date();
  const existing = await db.collection(MEETING_TOPICS_COLLECTION).findOne({
    tenantId,
    namaNorm,
  }) as MeetingTopicDoc | null;

  if (existing) {
    await db.collection(MEETING_TOPICS_COLLECTION).updateOne(
      { id: existing.id },
      {
        $set: { nama, updatedAt: now, aktif: true },
        $inc: { usageCount: 1 },
      },
    );
    return { ...existing, nama, updatedAt: now, aktif: true };
  }

  const doc: MeetingTopicDoc = {
    id: uuidv4(),
    tenantId,
    nama,
    namaNorm,
    aktif: true,
    usageCount: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: actor.userId,
    createdByName: actor.userName,
  };
  await db.collection(MEETING_TOPICS_COLLECTION).insertOne(doc);
  return doc;
}

export async function handleMeetingRecords(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, url, body, request } = ctx;
  const b = (body || {}) as Record<string, unknown>;
  const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
  if (deniedRole) return deniedRole;

  await ensureMeetingIndexes(db);

  // ── Topics suggest ──
  if (route === '/meeting-topics' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const filter = withTenantFilter(scopeAuth, { aktif: { $ne: false } }) as Record<string, unknown>;
    const q = normalizeMeetingLabelKey(String(url.searchParams.get('q') || ''));
    if (q) {
      filter.namaNorm = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
    }
    const list = await db.collection(MEETING_TOPICS_COLLECTION)
      .find(filter)
      .sort({ usageCount: -1, nama: 1 })
      .limit(q ? 12 : 50)
      .toArray();
    return ok(list.map((d) => clean(d)));
  }

  // ── List records ──
  if (route === '/meeting-records' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const filter = withTenantFilter(scopeAuth, {}) as Record<string, unknown>;
    const status = String(url.searchParams.get('status') || '').toUpperCase();
    if (isMeetingRecordStatus(status)) filter.status = status;
    const topicId = String(url.searchParams.get('topicId') || '').trim();
    if (topicId) filter.topicId = topicId;
    const kitchenId = String(url.searchParams.get('kitchenId') || '').trim();
    if (kitchenId) filter.kitchenId = kitchenId;
    const q = normalizeMeetingLabel(String(url.searchParams.get('q') || ''));
    if (q) {
      const re = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      filter.$or = [{ title: re }, { noDokumen: re }, { topicNama: re }];
    }
    const list = await db.collection(MEETING_RECORDS_COLLECTION)
      .find(filter)
      .sort({ meetingAt: -1, createdAt: -1 })
      .limit(200)
      .toArray();
    return ok(list.map((d) => normalizeRecord(d as Record<string, unknown>)));
  }

  // ── Create ──
  if (route === '/meeting-records' && method === 'POST') {
    const { denied, scopeAuth, tenantId: scopedTenant } = resolveOperationalScope(auth, {
      url, body: b, request,
    });
    if (denied) return denied;
    if (!scopeAuth || !scopedTenant) return err('Scope tidak valid', 400);
    const tenantId = tenantIdForWrite(scopeAuth, b) || scopedTenant;
    const title = normalizeMeetingLabel(String(b.title || ''));
    if (!title) return err('Judul pertemuan wajib diisi');

    const topic = await upsertMeetingTopic(db, tenantId, String(b.topicNama || b.topic || ''), {
      userId: auth?.userId,
      userName: actorName(auth),
    });
    if ('error' in topic) return err(topic.error, 400);

    const actionItems = parseActionItems(b.actionItems);
    if ('error' in actionItems) return err(actionItems.error, 400);

    const photos = await persistMeetingPhotos(tenantId, b.photos);
    if ('error' in photos) return err(photos.error, 400);

    const materials = await persistMeetingMaterials(tenantId, b.materials);
    if ('error' in materials) return err(materials.error, 400);

    const statusRaw = String(b.status || 'DRAFT').toUpperCase();
    const status: MeetingRecordStatus = isMeetingRecordStatus(statusRaw) ? statusRaw : 'DRAFT';

    const meetingAtRaw = b.meetingAt ? new Date(String(b.meetingAt)) : new Date();
    if (Number.isNaN(meetingAtRaw.getTime())) return err('Tanggal/waktu pertemuan tidak valid', 400);

    const kitchenId = b.kitchenId ? String(b.kitchenId).trim() : undefined;
    const kitchenNama = await resolveKitchenNama(
      db,
      tenantId,
      kitchenId,
      String(b.kitchenNama || '').trim() || undefined,
    );

    const noDokumen = await nextDocNumber(db, tenantId, MEETING_RECORD_DOC_TYPE, MEETING_RECORD_PREFIX);
    const now = new Date();
    const doc: MeetingRecordDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen,
      topicId: topic.id,
      topicNama: topic.nama,
      title,
      meetingAt: meetingAtRaw,
      location: normalizeMeetingLabel(String(b.location || '')) || undefined,
      attendees: parseAttendees(b.attendees),
      agenda: String(b.agenda || '').trim() || undefined,
      notes: String(b.notes || '').trim() || undefined,
      actionItems: actionItems.map((a) => ({ ...a, id: a.id.startsWith('ai-') ? uuidv4() : a.id })),
      photos,
      materials,
      status,
      kitchenId,
      kitchenNama,
      createdAt: now,
      updatedAt: now,
      createdBy: auth?.userId,
      createdByName: actorName(auth),
    };
    await db.collection(MEETING_RECORDS_COLLECTION).insertOne(doc);
    return ok(normalizeRecord(doc as unknown as Record<string, unknown>));
  }

  // ── Get one ──
  if (route.startsWith('/meeting-records/') && method === 'GET') {
    const id = route.slice('/meeting-records/'.length).split('/')[0];
    if (!id) return err('ID wajib', 400);
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const filter = withTenantFilter(scopeAuth, { id }) as Record<string, unknown>;
    const doc = await db.collection(MEETING_RECORDS_COLLECTION).findOne(filter);
    if (!doc) return err('Meeting record tidak ditemukan', 404);
    return ok(normalizeRecord(doc as Record<string, unknown>));
  }

  // ── Patch ──
  if (route.startsWith('/meeting-records/') && method === 'PATCH') {
    const id = route.slice('/meeting-records/'.length).split('/')[0];
    if (!id) return err('ID wajib', 400);
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: b, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const filter = withTenantFilter(scopeAuth, { id }) as Record<string, unknown>;
    const existing = await db.collection(MEETING_RECORDS_COLLECTION).findOne(filter) as MeetingRecordDoc | null;
    if (!existing) return err('Meeting record tidak ditemukan', 404);

    if (existing.status === 'FINAL' && !canEditFinal(auth)) {
      return err('Dokumen FINAL hanya bisa diubah oleh Admin/Owner', 403);
    }

    const tenantId = String(existing.tenantId);
    const patch: Record<string, unknown> = { updatedAt: new Date() };

    if (b.title !== undefined) {
      const title = normalizeMeetingLabel(String(b.title || ''));
      if (!title) return err('Judul pertemuan wajib diisi');
      patch.title = title;
    }
    if (b.topicNama !== undefined || b.topic !== undefined) {
      const topic = await upsertMeetingTopic(db, tenantId, String(b.topicNama || b.topic || ''), {
        userId: auth?.userId,
        userName: actorName(auth),
      });
      if ('error' in topic) return err(topic.error, 400);
      patch.topicId = topic.id;
      patch.topicNama = topic.nama;
    }
    if (b.meetingAt !== undefined) {
      const meetingAtRaw = new Date(String(b.meetingAt));
      if (Number.isNaN(meetingAtRaw.getTime())) return err('Tanggal/waktu pertemuan tidak valid', 400);
      patch.meetingAt = meetingAtRaw;
    }
    if (b.location !== undefined) {
      patch.location = normalizeMeetingLabel(String(b.location || '')) || null;
    }
    if (b.attendees !== undefined) patch.attendees = parseAttendees(b.attendees);
    if (b.agenda !== undefined) patch.agenda = String(b.agenda || '').trim() || null;
    if (b.notes !== undefined) patch.notes = String(b.notes || '').trim() || null;
    if (b.status !== undefined) {
      const statusRaw = String(b.status || '').toUpperCase();
      if (!isMeetingRecordStatus(statusRaw)) return err('Status tidak valid', 400);
      patch.status = statusRaw;
    }
    if (b.actionItems !== undefined) {
      const actionItems = parseActionItems(b.actionItems);
      if ('error' in actionItems) return err(actionItems.error, 400);
      patch.actionItems = actionItems.map((a) => ({
        ...a,
        id: a.id && !a.id.startsWith('ai-') ? a.id : uuidv4(),
      }));
    }
    if (b.photos !== undefined) {
      const photos = await persistMeetingPhotos(tenantId, b.photos);
      if ('error' in photos) return err(photos.error, 400);
      patch.photos = photos;
    }
    if (b.materials !== undefined) {
      const materials = await persistMeetingMaterials(tenantId, b.materials);
      if ('error' in materials) return err(materials.error, 400);
      patch.materials = materials;
    }
    if (b.kitchenId !== undefined || b.kitchenNama !== undefined) {
      const kitchenId = b.kitchenId !== undefined
        ? (b.kitchenId ? String(b.kitchenId).trim() : null)
        : (existing.kitchenId || null);
      const kitchenNama = kitchenId
        ? await resolveKitchenNama(
          db,
          tenantId,
          kitchenId,
          b.kitchenNama !== undefined
            ? String(b.kitchenNama || '').trim() || undefined
            : existing.kitchenNama,
        )
        : null;
      patch.kitchenId = kitchenId;
      patch.kitchenNama = kitchenNama || null;
    }

    await db.collection(MEETING_RECORDS_COLLECTION).updateOne({ id, tenantId }, { $set: patch });
    const updated = await db.collection(MEETING_RECORDS_COLLECTION).findOne({ id, tenantId });
    return ok(normalizeRecord((updated || {}) as Record<string, unknown>));
  }

  return null;
}
