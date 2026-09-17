/**
 * Meeting Record (MoM) — Keamanan Pangan.
 * Topik creatable + action items + foto bukti + bahan meeting (FILE/LINK).
 */

export const MEETING_RECORDS_COLLECTION = 'meeting_records';
export const MEETING_TOPICS_COLLECTION = 'meeting_topics';

export const MEETING_RECORD_DOC_TYPE = 'MEETING_RECORD';
export const MEETING_RECORD_PREFIX = 'MOM';

export type MeetingRecordStatus = 'DRAFT' | 'FINAL';
export type MeetingActionItemStatus = 'OPEN' | 'CLOSED';
export type MeetingMaterialKind = 'FILE' | 'LINK';

export interface MeetingActionItem {
  id: string;
  text: string;
  picName: string;
  dueDate?: string;
  status: MeetingActionItemStatus;
}

export interface MeetingMaterial {
  id: string;
  kind: MeetingMaterialKind;
  title: string;
  url: string;
  mimeType?: string;
  sizeBytes?: number;
  originalName?: string;
}

export interface MeetingTopicDoc {
  id: string;
  tenantId: string;
  nama: string;
  namaNorm: string;
  aktif: boolean;
  usageCount?: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

export interface MeetingRecordDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  topicId: string;
  topicNama: string;
  title: string;
  meetingAt: Date | string;
  location?: string;
  attendees: string[];
  agenda?: string;
  notes?: string;
  actionItems: MeetingActionItem[];
  photos: string[];
  materials: MeetingMaterial[];
  status: MeetingRecordStatus;
  kitchenId?: string;
  kitchenNama?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

export const MEETING_RECORD_STATUS_LABELS: Record<MeetingRecordStatus, string> = {
  DRAFT: 'Draft',
  FINAL: 'Final',
};

export const MEETING_ACTION_STATUS_LABELS: Record<MeetingActionItemStatus, string> = {
  OPEN: 'Open',
  CLOSED: 'Closed',
};

export const MEETING_MATERIAL_KIND_LABELS: Record<MeetingMaterialKind, string> = {
  FILE: 'File',
  LINK: 'Link',
};

export const MAX_MEETING_PHOTOS = 5;
export const MAX_MEETING_MATERIALS = 10;
export const MAX_MEETING_MATERIAL_DOC_BYTES = 10 * 1024 * 1024;
export const MAX_MEETING_MATERIAL_VIDEO_BYTES = 25 * 1024 * 1024;

export const MEETING_MATERIAL_FILE_EXTS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'png', 'jpg', 'jpeg', 'webp', 'gif',
  'mp4', 'webm',
] as const;

export const MEETING_MATERIAL_VIDEO_EXTS = new Set(['mp4', 'webm']);

/** Normalize label untuk unik + search (pola nama resep). */
export function normalizeMeetingLabel(value: string): string {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

export function normalizeMeetingLabelKey(value: string): string {
  return normalizeMeetingLabel(value).toLowerCase();
}

export function isMeetingRecordStatus(v: unknown): v is MeetingRecordStatus {
  return v === 'DRAFT' || v === 'FINAL';
}

export function isMeetingActionItemStatus(v: unknown): v is MeetingActionItemStatus {
  return v === 'OPEN' || v === 'CLOSED';
}

export function isMeetingMaterialKind(v: unknown): v is MeetingMaterialKind {
  return v === 'FILE' || v === 'LINK';
}

export function parseAttendees(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x || '').trim()).filter(Boolean);
  }
  const text = String(raw || '');
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseActionItems(raw: unknown): MeetingActionItem[] | { error: string } {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: 'Format action items tidak valid' };
  const out: MeetingActionItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    if (!row || typeof row !== 'object') return { error: `Action item #${i + 1} tidak valid` };
    const text = String(row.text || '').trim();
    if (!text) return { error: `Action item #${i + 1}: deskripsi wajib` };
    const picName = String(row.picName || row.pic || '').trim();
    const dueRaw = row.dueDate != null ? String(row.dueDate).trim() : '';
    if (dueRaw && !/^\d{4}-\d{2}-\d{2}$/.test(dueRaw)) {
      return { error: `Action item #${i + 1}: due date harus YYYY-MM-DD` };
    }
    const statusRaw = String(row.status || 'OPEN').toUpperCase();
    if (!isMeetingActionItemStatus(statusRaw)) {
      return { error: `Action item #${i + 1}: status harus OPEN atau CLOSED` };
    }
    out.push({
      id: String(row.id || '').trim() || `ai-${i + 1}`,
      text,
      picName,
      ...(dueRaw ? { dueDate: dueRaw } : {}),
      status: statusRaw,
    });
  }
  return out;
}

export function countOpenActionItems(items: MeetingActionItem[] | undefined): number {
  return (items || []).filter((a) => a.status === 'OPEN').length;
}

function shortLinkTitle(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname.slice(0, 40);
    return `${u.hostname}${path}`;
  } catch {
    return url.slice(0, 60);
  }
}

export function isAllowedHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Parse materials metadata. FILE dengan data: URL masih dianggap valid di sini;
 * persist base64 → disk dilakukan di handler.
 */
export function parseMeetingMaterials(raw: unknown): MeetingMaterial[] | { error: string } {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: 'Format bahan meeting tidak valid' };
  if (raw.length > MAX_MEETING_MATERIALS) {
    return { error: `Maksimal ${MAX_MEETING_MATERIALS} bahan meeting` };
  }
  const out: MeetingMaterial[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    if (!row || typeof row !== 'object') return { error: `Bahan #${i + 1} tidak valid` };
    const kindRaw = String(row.kind || '').toUpperCase();
    if (!isMeetingMaterialKind(kindRaw)) {
      return { error: `Bahan #${i + 1}: kind harus FILE atau LINK` };
    }
    const url = String(row.url || '').trim();
    if (!url) return { error: `Bahan #${i + 1}: URL / file wajib` };

    if (kindRaw === 'LINK') {
      if (!isAllowedHttpUrl(url)) {
        return { error: `Bahan #${i + 1}: link harus http:// atau https://` };
      }
      const title = normalizeMeetingLabel(String(row.title || '')) || shortLinkTitle(url);
      out.push({
        id: String(row.id || '').trim() || `mat-${i + 1}`,
        kind: 'LINK',
        title,
        url,
      });
      continue;
    }

    // FILE — url boleh /api/media, http(s), atau data: (belum di-persist)
    const originalName = String(row.originalName || row.title || '').trim() || undefined;
    const title = normalizeMeetingLabel(String(row.title || originalName || '')) || `File ${i + 1}`;
    const mimeType = row.mimeType != null ? String(row.mimeType) : undefined;
    const sizeRaw = row.sizeBytes != null ? Number(row.sizeBytes) : undefined;
    const sizeBytes = sizeRaw != null && Number.isFinite(sizeRaw) && sizeRaw >= 0 ? sizeRaw : undefined;
    out.push({
      id: String(row.id || '').trim() || `mat-${i + 1}`,
      kind: 'FILE',
      title,
      url,
      ...(mimeType ? { mimeType } : {}),
      ...(sizeBytes != null ? { sizeBytes } : {}),
      ...(originalName ? { originalName } : {}),
    });
  }
  return out;
}

export function maxBytesForMaterialExt(ext: string): number {
  return MEETING_MATERIAL_VIDEO_EXTS.has(String(ext || '').toLowerCase())
    ? MAX_MEETING_MATERIAL_VIDEO_BYTES
    : MAX_MEETING_MATERIAL_DOC_BYTES;
}
