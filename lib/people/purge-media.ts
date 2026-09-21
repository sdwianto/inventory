import type { Db } from 'mongodb';
import { deleteMediaFile } from '@/lib/api/media-storage';
import { PEOPLE_COLLECTION } from '@/lib/people/person';

const PERSON_MEDIA_COLLECTIONS = [PEOPLE_COLLECTION, 'kitchen_people'] as const;

/** Nama file disk dari dokumen personel — dipakai tes + purge. */
export function personAttachmentFilenames(docs: Array<{ attachments?: Array<{ filename?: string }> }>): string[] {
  const out: string[] = [];
  for (const doc of docs) {
    for (const att of doc.attachments || []) {
      const fn = String(att?.filename || '').trim();
      if (fn) out.push(fn);
    }
  }
  return out;
}

/** Hapus berkas HR di disk sebelum deleteMany people (spec 1.2). */
export async function purgePersonMedia(
  db: Db,
  tenantId?: string,
): Promise<number> {
  const filter = tenantId ? { tenantId } : {};
  let n = 0;
  for (const name of PERSON_MEDIA_COLLECTIONS) {
    const docs = await db.collection(name)
      .find(filter)
      .project({ tenantId: 1, attachments: 1 })
      .toArray();
    for (const doc of docs) {
      const tid = String(doc.tenantId || tenantId || 'default');
      for (const fn of personAttachmentFilenames([doc as { attachments?: Array<{ filename?: string }> }])) {
        await deleteMediaFile(tid, fn);
        n += 1;
      }
    }
  }
  return n;
}
