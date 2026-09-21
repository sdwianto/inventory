import { createHash } from 'crypto';
import {
  PERSON_BANK_CATALOG,
  normalizeAccountNo,
  type PersonBankCode,
} from '@/lib/people/person';
import { normalizeTxnDate, parseRupiahAmount } from '@/lib/people/person-payment';

export type ParsedBniDebit = {
  valueDate: string;
  description: string;
  amount: number;
  bankRef: string;
  accountNo?: string;
  counterpartyAccount?: string;
  counterpartyBank?: PersonBankCode;
  counterpartyName?: string;
  warnings: string[];
};

const HEADER_ALIASES: Record<string, string> = {
  tanggal: 'tanggal',
  tgl: 'tanggal',
  date: 'tanggal',
  'value date': 'tanggal',
  'tanggal transaksi': 'tanggal',
  keterangan: 'keterangan',
  deskripsi: 'keterangan',
  description: 'keterangan',
  remarks: 'keterangan',
  narasi: 'keterangan',
  debet: 'debet',
  debit: 'debet',
  db: 'debet',
  withdrawal: 'debet',
  kredit: 'kredit',
  credit: 'kredit',
  cr: 'kredit',
  deposit: 'kredit',
  saldo: 'saldo',
  balance: 'saldo',
  ntb: 'ntb',
  'no. ref': 'ntb',
  noref: 'ntb',
  'no ref': 'ntb',
  referensi: 'ntb',
  ref: 'ntb',
  journal: 'ntb',
  trailer: 'ntb',
  'no transaksi': 'ntb',
  'nomor transaksi': 'ntb',
  rekening: 'rekening',
  'no rekening': 'rekening',
  'no. rekening': 'rekening',
  'account no': 'rekening',
  'account number': 'rekening',
};

function detectDelimiter(headerLine: string): string {
  const semi = (headerLine.match(/;/g) || []).length;
  const comma = (headerLine.match(/,/g) || []).length;
  return semi >= comma ? ';' : ',';
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function normalizeHeader(raw: string): string {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function mapHeader(raw: string): string | null {
  const key = normalizeHeader(raw);
  return HEADER_ALIASES[key] || null;
}

export function extractCounterpartyFromDescription(description: string): {
  account?: string;
  bank?: PersonBankCode;
  name?: string;
} {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  if (!text) return {};
  const upper = text.toUpperCase();

  const banksFound: PersonBankCode[] = [];
  for (const item of PERSON_BANK_CATALOG) {
    if (item.code === 'LAINNYA') continue;
    const codeHit = new RegExp(`\\b${item.code}\\b`).test(upper);
    const namaHit = upper.includes(item.nama.toUpperCase());
    if (codeHit || namaHit) banksFound.push(item.code);
  }
  const destBanks = banksFound.filter((b) => b !== 'BNI');
  const bank = destBanks[0] || banksFound[0];

  let account: string | undefined;
  const afterKe = text.match(/\bKE(?:PADA)?\s+(?:BANK\s+)?(?:[A-Z]{2,}\s+)?(\d{8,16})\b/i);
  if (afterKe) {
    account = normalizeAccountNo(afterKe[1]);
  } else if (bank) {
    const afterBank = upper.match(new RegExp(`\\b${bank}\\b[^\\d]{0,16}(\\d{8,16})\\b`));
    if (afterBank) account = normalizeAccountNo(afterBank[1]);
  }
  if (!account) {
    const all = [...text.matchAll(/\b(\d{8,16})\b/g)].map((m) => normalizeAccountNo(m[1]));
    if (all.length) account = all[all.length - 1];
  }

  const nameMatch = text.match(/\bAN\.?\s+([A-Z0-9 .'-]{3,60})/i)
    || text.match(/\bA\/N\.?\s+([A-Z0-9 .'-]{3,60})/i);
  const name = nameMatch ? nameMatch[1].trim().replace(/\s+/g, ' ') : undefined;
  return { account, bank, name };
}

function fallbackBankRef(valueDate: string, amount: number, description: string): string {
  const digest = createHash('sha1')
    .update(`${valueDate}|${amount}|${description}`)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
  return `BNI-${digest}`;
}

export function parseBniMutasiCsv(csvText: string): {
  rows: ParsedBniDebit[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const text = String(csvText || '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], warnings: ['File CSV kosong'] };

  const delimiter = detectDelimiter(lines[0]);
  const headerCells = splitCsvLine(lines[0], delimiter);
  const mapped = headerCells.map(mapHeader);
  if (!mapped.includes('tanggal') && !mapped.includes('keterangan') && !mapped.includes('debet')) {
    warnings.push('Header CSV tidak dikenali — baris pertama dipakai sebagai data');
  }

  const col = (name: string) => mapped.indexOf(name);
  const iTanggal = col('tanggal');
  const iKet = col('keterangan');
  const iDebet = col('debet');
  const iKredit = col('kredit');
  const iNtb = col('ntb');
  const iRek = col('rekening');
  const start = mapped.some(Boolean) ? 1 : 0;

  const rows: ParsedBniDebit[] = [];
  for (let n = start; n < lines.length; n++) {
    const cells = splitCsvLine(lines[n], delimiter);
    const lineNo = n + 1;
    try {
      const tanggalRaw = iTanggal >= 0 ? cells[iTanggal] : cells[0];
      const ket = iKet >= 0 ? cells[iKet] : cells[1] || '';
      const debet = parseRupiahAmount(iDebet >= 0 ? cells[iDebet] : cells[2]);
      const kredit = parseRupiahAmount(iKredit >= 0 ? cells[iKredit] : cells[3]);
      if (kredit > 0 && debet <= 0) continue;
      if (debet <= 0) {
        warnings.push(`Baris ${lineNo}: dilewati (bukan debet)`);
        continue;
      }
      const valueDate = normalizeTxnDate(tanggalRaw);
      if (!valueDate) {
        warnings.push(`Baris ${lineNo}: tanggal tidak valid`);
        continue;
      }
      const ntb = String(iNtb >= 0 ? cells[iNtb] || '' : '').trim();
      const extracted = extractCounterpartyFromDescription(ket);
      const rowWarnings: string[] = [];
      const bankRef = ntb || fallbackBankRef(valueDate, debet, ket);
      if (!ntb) rowWarnings.push('NTB kosong — ref sintetis dipakai untuk idempotensi');
      rows.push({
        valueDate,
        description: ket,
        amount: debet,
        bankRef,
        accountNo: iRek >= 0 ? normalizeAccountNo(cells[iRek]) || undefined : undefined,
        counterpartyAccount: extracted.account,
        counterpartyBank: extracted.bank,
        counterpartyName: extracted.name,
        warnings: rowWarnings,
      });
    } catch (e) {
      warnings.push(`Baris ${lineNo}: ${e instanceof Error ? e.message : 'gagal diurai'}`);
    }
  }

  return { rows, warnings };
}
