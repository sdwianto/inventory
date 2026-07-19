import type { ClientSession, Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import type { CreateJournalParams, JournalDetail, JournalEntry } from '@/types/finance';
import { txOpts } from '@/lib/api/transaction';
import { nextDocNumber } from '@/lib/api/document-sequence';

export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalError';
  }
}

export async function createJournal(
  db: Db,
  {
    tanggal,
    keterangan,
    sourceType,
    sourceId,
    details,
    userName,
    tenantId = 'default',
  }: CreateJournalParams,
  session?: ClientSession,
): Promise<JournalEntry> {
  const totalDebet = details.reduce((s: number, d: JournalDetail) => s + (d.debet || 0), 0);
  const totalKredit = details.reduce((s: number, d: JournalDetail) => s + (d.kredit || 0), 0);
  if (totalDebet !== totalKredit) {
    throw new JournalError(
      `Jurnal tidak balance (${sourceType}): debet ${totalDebet} != kredit ${totalKredit}`,
    );
  }
  if (totalDebet === 0) {
    throw new JournalError(`Jurnal total nol (${sourceType})`);
  }

  const now = tanggal || new Date();
  const letter = String(sourceType || 'X').charAt(0).toUpperCase() || 'X';
  const prefix = `J${letter}`;
  const noJurnal = await nextDocNumber(db, tenantId || 'default', prefix, prefix, session);

  const doc: JournalEntry = {
    id: uuidv4(),
    tenantId: tenantId || 'default',
    noJurnal,
    tanggal: now,
    keterangan,
    sourceType,
    sourceId: sourceId || null,
    details,
    totalDebet,
    totalKredit,
    userName: userName || '',
    createdAt: new Date(),
  };
  await db.collection('jurnal').insertOne(doc, txOpts(session));
  return doc;
}

/** Skip insert when a journal with the same source already exists (idempotent posting). */
export async function createJournalIfNotExists(
  db: Db,
  params: CreateJournalParams,
  session?: ClientSession,
): Promise<JournalEntry | null> {
  const tid = params.tenantId || 'default';
  if (params.sourceId) {
    const existing = await db.collection('jurnal').findOne({
      tenantId: tid,
      sourceType: params.sourceType,
      sourceId: String(params.sourceId),
    }, txOpts(session));
    if (existing) return existing as unknown as JournalEntry;
  }
  return createJournal(db, params, session);
}
