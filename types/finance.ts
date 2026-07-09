export interface JournalDetail {
  rekeningKode: string;
  rekeningNama: string;
  debet: number;
  kredit: number;
  keterangan?: string;
}

export interface JournalEntry {
  id: string;
  tenantId: string;
  noJurnal: string;
  tanggal: Date;
  keterangan?: string;
  sourceType: string;
  sourceId?: string | null;
  details: JournalDetail[];
  totalDebet: number;
  totalKredit: number;
  userName?: string;
  createdAt?: Date;
}

export interface CreateJournalParams {
  tanggal?: Date | null;
  keterangan?: string;
  sourceType: string;
  sourceId?: string | null;
  details: JournalDetail[];
  userName?: string;
  tenantId?: string;
}

export interface VendorHutangJournalParams {
  noDoc: string;
  subTotal: number;
  ppn?: number;
  total: number;
}

export interface HutangPaymentJournalParams {
  noDoc: string;
  amount: number;
  metode?: string;
  kasRekeningKode?: string;
  kasRekeningNama?: string;
}
