// @deprecated Warisan sales.app (jurnal kasir) — tidak dipakai inventory customer.
// Auto-journal helper — tenant-scoped jurnal collection.

import { v4 as uuidv4 } from 'uuid';

export class JournalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JournalError';
  }
}

export async function createJournal(db, {
  tanggal,
  keterangan,
  sourceType,
  sourceId,
  details,
  userName,
  tenantId = 'default',
}) {
  const totalDebet = details.reduce((s, d) => s + (d.debet || 0), 0);
  const totalKredit = details.reduce((s, d) => s + (d.kredit || 0), 0);
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

  const doc = {
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
  await db.collection('jurnal').insertOne(doc);
  return doc;
}
