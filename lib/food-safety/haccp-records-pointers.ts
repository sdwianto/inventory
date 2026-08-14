/**
 * Gelombang E — pointer rekaman wajib (bukan collection baru).
 */

export const HACCP_RECORDS_POINTERS: Array<{
  key: string;
  label: string;
  href: string;
}> = [
  { key: 'ccp', label: 'Catatan CCP / monitoring', href: '/kitchen-assurance/operasi' },
  { key: 'temp', label: 'Log suhu rantai dingin', href: '/food-production/cold-chain' },
  { key: 'prp', label: 'Checklist prasyarat (PRP)', href: '/kitchen-assurance/setup' },
  { key: 'temuan', label: 'Temuan & bukti perbaikan', href: '/kitchen-assurance/temuan' },
  { key: 'verify', label: 'Validasi / verifikasi rencana', href: '/food-production/haccp-plan?wizard=1&step=E' },
];
