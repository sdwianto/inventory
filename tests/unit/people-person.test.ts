import { describe, expect, it } from 'vitest';
import {
  assertBankAccounts,
  assertCanAddAttachment,
  estimateBase64Bytes,
  isFotoMime,
  isPersonEffective,
  normalizeAccountNo,
  normalizeBankCode,
  normalizeNik,
  normalizePersonNama,
  PERSON_CODE_DOC_TYPE,
  PERSON_CODE_PREFIX,
  projectPersonDetail,
  projectPersonList,
  publicAttachment,
  resolvePersonSnapshot,
  type KitchenPersonAttachment,
  type KitchenPersonDoc,
} from '@/lib/people/person';
import { isRestrictedPublicMediaFilename } from '@/lib/api/handlers/media';
import { REKENING_DEFAULTS } from '@/lib/api/tenant-master';
import { PEOPLE_MANAGE_ROLES } from '@/lib/people/roles';

function person(over: Partial<KitchenPersonDoc> = {}): KitchenPersonDoc {
  const now = new Date('2026-09-20T00:00:00.000Z');
  return {
    id: 'p1',
    tenantId: 'sppg',
    kode: 'KDP0001',
    nama: 'Siti Aminah',
    jenis: 'KARYAWAN',
    peran: 'JURU_MASAK',
    jabatan: 'Juru masak',
    nik: '3201011212340001',
    kitchenIds: ['k1'],
    bankAccounts: [{
      bankCode: 'BCA',
      bankNama: 'Bank BCA',
      accountNo: '1234567890',
      accountName: 'Siti Aminah',
      isPrimary: true,
    }],
    aktif: true,
    attachments: [{
      id: 'a1',
      kind: 'FOTO',
      title: 'Pasfoto',
      filename: 'secret-disk-name.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 12,
      uploadedAt: now,
    }],
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('people helpers', () => {
  it('normalizes norek to digits only', () => {
    expect(normalizeAccountNo('123-456 7890')).toBe('1234567890');
    expect(normalizeAccountNo('  0011.22  ')).toBe('001122');
  });

  it('requires non-empty NIK of any format up to 64 chars', () => {
    expect(normalizeNik('')).toBe(null);
    expect(normalizeNik(null)).toBe(null);
    expect(normalizeNik('   ')).toBe(null);
    expect(normalizeNik('kpj001')).toBe('kpj001');
    expect(normalizeNik('  KPJ 001 ')).toBe('KPJ 001');
    expect(normalizeNik('3201.0112.1234.0001')).toBe('3201.0112.1234.0001');
    expect(normalizeNik('3201011212340001')).toBe('3201011212340001');
    expect(normalizeNik('a'.repeat(65))).toBe(null);
  });

  it('rejects unknown bank code', () => {
    expect(normalizeBankCode('bca')).toBe('BCA');
    expect(normalizeBankCode('XYZ')).toBe(null);
  });

  it('rejects duplicate bank+norek after normalize', () => {
    const r = assertBankAccounts([
      { bankCode: 'BNI', accountNo: '111-222', accountName: 'A', isPrimary: true },
      { bankCode: 'BNI', accountNo: '111222', accountName: 'A' },
    ]);
    expect(r).toEqual({ error: 'Rekening BNI 111222 duplikat' });
  });

  it('rejects two primary accounts', () => {
    const r = assertBankAccounts([
      { bankCode: 'BCA', accountNo: '111111', accountName: 'A', isPrimary: true },
      { bankCode: 'BNI', accountNo: '222222', accountName: 'A', isPrimary: true },
    ]);
    expect(r).toEqual({ error: 'Hanya satu rekening yang boleh primary' });
  });

  it('auto-assigns first account as primary when none set', () => {
    const r = assertBankAccounts([
      { bankCode: 'BCA', accountNo: '11111111', accountName: 'A' },
      { bankCode: 'BNI', accountNo: '22222222', accountName: 'B' },
    ]);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r[0].isPrimary).toBe(true);
    expect(r[1].isPrimary).toBe(false);
    expect(r[0].bankNama).toBe('Bank BCA');
  });

  it('isPersonEffective respects aktif and masa tugas', () => {
    expect(isPersonEffective({ aktif: true }, '2026-09-20')).toBe(true);
    expect(isPersonEffective({ aktif: false }, '2026-09-20')).toBe(false);
    expect(isPersonEffective({ aktif: true, effectiveFrom: '2026-10-01' }, '2026-09-20')).toBe(false);
    expect(isPersonEffective({ aktif: true, effectiveTo: '2026-09-01' }, '2026-09-20')).toBe(false);
    expect(isPersonEffective({ aktif: true, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' }, '2026-09-20')).toBe(true);
  });

  it('snapshot omits attachments and rekening, rejects expired/inactive', () => {
    const snap = resolvePersonSnapshot(person(), '2026-09-20');
    expect(snap).toEqual({
      personId: 'p1',
      kode: 'KDP0001',
      nama: 'Siti Aminah',
      nik: '3201011212340001',
      jabatan: 'Juru masak',
      jenis: 'KARYAWAN',
    });
    expect(JSON.stringify(snap)).not.toContain('secret-disk-name');
    expect(JSON.stringify(snap)).not.toContain('1234567890');
    expect(JSON.stringify(snap)).not.toContain('attachments');

    expect(resolvePersonSnapshot(person({ aktif: false }))).toEqual({ error: 'Personel nonaktif' });
    expect(resolvePersonSnapshot(person({ effectiveTo: '2026-01-01' }), '2026-09-20')).toEqual({
      error: 'Personel di luar masa tugas',
    });
  });

  it('list/detail projection never exposes filename', () => {
    const list = projectPersonList(person());
    expect(list).not.toHaveProperty('attachments');
    expect(list.attachmentCount).toBe(1);
    expect(JSON.stringify(list)).not.toContain('secret-disk-name');

    const detail = projectPersonDetail(person(), { paymentCount: 0 });
    expect(detail.attachments[0]).not.toHaveProperty('filename');
    expect(publicAttachment(person().attachments[0] as KitchenPersonAttachment)).not.toHaveProperty('filename');
    expect(JSON.stringify(detail)).not.toContain('secret-disk-name');
    expect(detail.paymentCount).toBe(0);
    expect(detail.lastPaidAt).toBeNull();
    expect(detail.lastPaidAmount).toBe(0);
  });

  it('detail payment stats come from aggregate payload, not the person document', () => {
    const detail = projectPersonDetail(person(), {
      paymentCount: 2,
      lastPaidAt: '2029-03-05',
      lastPaidAmount: 1_500_000,
    });
    expect(detail.paymentCount).toBe(2);
    expect(detail.lastPaidAt).toBe('2029-03-05');
    expect(detail.lastPaidAmount).toBe(1_500_000);
    expect(projectPersonList(person())).not.toHaveProperty('paymentCount');
  });

  it('caps foto and dokumen counts', () => {
    const fotos: KitchenPersonAttachment[] = [1, 2, 3].map((n) => ({
      id: `f${n}`,
      kind: 'FOTO' as const,
      title: 'f',
      filename: 'x',
      mimeType: 'image/jpeg',
      sizeBytes: 1,
      uploadedAt: new Date(),
    }));
    expect(assertCanAddAttachment(fotos, 'FOTO')).toMatch(/Maksimal 3 foto/);
    expect(assertCanAddAttachment(fotos, 'KONTRAK')).toBeNull();
  });

  it('collapses person nama whitespace', () => {
    expect(normalizePersonNama('  Siti   Aminah ')).toBe('Siti Aminah');
  });

  it('uses KDP prefix so sprint 2 match tetap menemukan KDP0001', () => {
    expect(PERSON_CODE_PREFIX).toBe('KDP');
    expect(PERSON_CODE_DOC_TYPE).toBe('kitchen_person');
  });

  it('allows only jpeg/png/webp for foto', () => {
    expect(isFotoMime('image/jpeg')).toBe(true);
    expect(isFotoMime('image/jpg')).toBe(true);
    expect(isFotoMime('image/png')).toBe(true);
    expect(isFotoMime('image/webp')).toBe(true);
    expect(isFotoMime('image/gif')).toBe(false);
    expect(isFotoMime('application/pdf')).toBe(false);
  });

  it('estimates base64 payload size', () => {
    expect(estimateBase64Bytes('data:image/jpeg;base64,AAAA')).toBe(3);
    expect(estimateBase64Bytes('')).toBe(0);
  });

  it('blocks public /api/media for HR prefixes', () => {
    expect(isRestrictedPublicMediaFilename('kdp-abc.jpg')).toBe(true);
    expect(isRestrictedPublicMediaFilename('kperson-foto-abc.jpg')).toBe(true);
    expect(isRestrictedPublicMediaFilename('logo-abc.jpg')).toBe(false);
  });

  it('seeds Bank BNI 10130 without replacing Mandiri 10110', () => {
    expect(REKENING_DEFAULTS.some((r) => r.kode === '10110' && r.nama === 'Bank Mandiri')).toBe(true);
    expect(REKENING_DEFAULTS.some((r) => r.kode === '10130' && r.nama === 'Bank BNI')).toBe(true);
  });

  it('keeps GUDANG out of PEOPLE_MANAGE', () => {
    expect(PEOPLE_MANAGE_ROLES).toEqual(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);
    expect(PEOPLE_MANAGE_ROLES).not.toContain('GUDANG');
  });
});
