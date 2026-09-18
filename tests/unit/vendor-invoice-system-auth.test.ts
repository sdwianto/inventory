import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { resolvePenerimaGudang } from '@/lib/api/hutang-approval';

describe('vendor invoice system auth footer', () => {
  it('A4 document: system auth + GRN penerima / Mengetahui slots; no Vendor wet-ink', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'components/VendorInvoiceDocument.tsx'),
      'utf8',
    );
    expect(src).toContain('Autentikasi sistem');
    expect(src).toContain('Salinan tagihan dari sistem');
    expect(src).toContain('bukan faktur pajak');
    expect(src).toContain('Penerima gudang');
    expect(src).toContain('Mengetahui');
    expect(src).not.toContain('Mengetahui (finance)');
    expect(src).toContain('Petugas Gudang');
    expect(src).toContain('Pengawas Keuangan');
    expect(src).toContain('Terverifikasi');
    expect(src).toContain('https://dapursppg.my.id/');
    expect(src).toContain('vendor-invoice-verification-seal');
    expect(src).toContain('SystemVerificationSeal');
    expect(src).toContain('InternalSignColumn');
    expect(src).toContain('Penerima gudang');
    expect(src).toContain('Petugas Gudang');
    expect(src).toContain('Pengawas Keuangan');
    // Kedua slot memakai kolom yang sama: judul → stempel → nama/NIK → garis → jabatan
    expect(src).toContain('title="Penerima gudang"');
    expect(src).toContain('title="Mengetahui"');
    expect(src).toContain('lineLabel="Petugas Gudang"');
    expect(src).toContain('lineLabel="Pengawas Keuangan"');
    expect(src).toContain('stamp?.userName || stamp?.nik || stamp?.at');
    // Label polos di slot Mengetahui sudah diganti stempel verifikasi
    expect(src).not.toContain('>{/* autentikasi sistem */}');
    expect(src).not.toMatch(/metaClass\} text-slate-500 mb-0\.5`\}>autentikasi sistem/);
    expect(src).not.toContain('( dari penerimaan GRN )');
    expect(src).not.toContain('showJabatanAbove');
    expect(src).not.toContain('penerimaStamped');
    expect(src).toContain('data-testid="vendor-invoice-system-auth"');
    expect(src).toContain('data-testid="vendor-invoice-internal-signs"');
    expect(src).toContain('approvedBy');
    expect(src).toContain('knowingBy');
    expect(src).toContain('penerimaGudang');

    // Both footerTrio (compact) and default paths mount the helpers
    expect((src.match(/<SystemAuthStrip\b/g) || []).length).toBe(2);
    expect((src.match(/<InternalSignatureSlots\b/g) || []).length).toBe(2);
    expect(src).toContain('<SystemAuthStrip detail={detail} approval={approval} compact />');
    expect(src).toContain('penerima={penerimaStamp}');
    expect(src).toContain('mengetahui={mengetahuiStamp}');

    // Legacy wet-ink vendor / hormat kami signature grids removed
    expect(src).not.toMatch(/\['Vendor',\s*'Penerima'/);
    expect(src).not.toContain('Hormat Kami');
    expect(src).not.toMatch(/\( tanda tangan &amp; cap \)/);
    expect(src).not.toContain('( tanda tangan &amp; cap — internal )');
  });

  it('Detail: Buat signature dialog + Setujui requires knowing draft', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'components/VendorInvoiceDetail.tsx'),
      'utf8',
    );
    expect(src).toContain('Buat signature');
    expect(src).toContain('HUTANG_KNOWING_SIG_KEY');
    expect(src).toContain('Signature Mengetahui');
    expect(src).toContain('Isi signature dulu');
    expect(src).toContain('isSignatureDraftReady');
  });

  it('Approve API requires knowingBy Nama + NIK', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'lib/api/handlers/vendor-hutang.ts'),
      'utf8',
    );
    expect(src).toContain('parseKnowingSignature');
    expect(src).toContain('knowingBy');
  });

  it('GRN post stamps receivedBy from actorSnapshot', () => {
    const handler = readFileSync(
      resolve(process.cwd(), 'lib/api/handlers/goods-receipts.ts'),
      'utf8',
    );
    const post = readFileSync(
      resolve(process.cwd(), 'lib/api/grn-post.ts'),
      'utf8',
    );
    const penerimaan = readFileSync(
      resolve(process.cwd(), 'app/penerimaan/page.tsx'),
      'utf8',
    );
    expect(handler).toContain('actorSnapshot');
    expect(handler).toContain('parseKnowingSignature');
    expect(handler).toContain('Penerima gudang');
    expect(handler).toContain('receivedBy');
    expect(post).toContain('receivedBy');
    expect(post).toContain('Signature Penerima gudang wajib');
    expect(post).not.toContain('...(receivedBy ? { receivedBy } : {})');
    expect(penerimaan).toContain('Buat signature');
    expect(penerimaan).toContain('GRN_RECEIVER_SIG_KEY');
    expect(penerimaan).toContain('Signature Penerima gudang');
  });

  it('enrich exposes penerimaGudang', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'lib/api/hutang-approval.ts'),
      'utf8',
    );
    expect(src).toContain('penerimaGudang');
    expect(src).toContain('hutangId: hutang.id');
    expect(src).toContain('requireComplete: true');
    expect(src).toContain("g.status === 'POSTED' ? resolvePenerimaGudang(g) : null");
    expect(src).toContain('grns.find((g) => g.status === \'POSTED\' && resolvePenerimaGudang(g))');
  });

  it('Thermal: human status + system copy; no vendor signature', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'components/VendorInvoiceThermal.tsx'),
      'utf8',
    );
    expect(src).toContain('Salinan sistem — bukan faktur pajak vendor');
    expect(src).toContain('APPROVAL_LABELS');
    expect(src).toContain('approvedBy');
    expect(src).toContain('knowingBy');
    expect(src).not.toContain('tanda tangan');
    expect(src).not.toMatch(/Hormat Kami/);
  });

  it('invoice catalog no longer advertises vendor triple wet-ink', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'lib/document-variants/catalog.ts'),
      'utf8',
    );
    const invBlock = src.slice(src.indexOf('INVOICE_VARIANTS'), src.indexOf('const BY_ID'));
    expect(invBlock).not.toMatch(/tiga tanda tangan Penjual/);
    expect(invBlock).toContain('autentikasi sistem');
    expect(invBlock).toContain('Mengetahui');
  });
});

describe('resolvePenerimaGudang', () => {
  it('prefers receivedBy over legacy userName', () => {
    expect(resolvePenerimaGudang({
      receivedBy: { userId: 'u1', userName: 'Budi', role: 'WAREHOUSE', nik: '99', jabatan: 'Petugas' },
      userName: 'Legacy',
    })).toEqual({
      userId: 'u1',
      userName: 'Budi',
      role: 'WAREHOUSE',
      nik: '99',
      jabatan: 'Petugas',
    });
  });

  it('falls back to userName string', () => {
    expect(resolvePenerimaGudang({ userName: 'Siti' })).toEqual({
      userId: '',
      userName: 'Siti',
      role: '',
    });
  });

  it('requireComplete rejects name-only legacy', () => {
    expect(resolvePenerimaGudang({ userName: 'Siti' }, { requireComplete: true })).toBeNull();
  });

  it('returns null when empty', () => {
    expect(resolvePenerimaGudang(null)).toBeNull();
    expect(resolvePenerimaGudang({})).toBeNull();
  });
});
