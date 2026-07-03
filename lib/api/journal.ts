import type { ClientSession, Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import type { CreateJournalParams, JournalDetail, JournalEntry } from '@/types/finance';
import { txOpts } from '@/lib/api/transaction';

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
  const noJurnal = `J${sourceType.charAt(0)}${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`;

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
