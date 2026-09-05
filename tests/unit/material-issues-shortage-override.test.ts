import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('material-issues POST — blokir lunak shortage (bahan tidak harus 100% lengkap)', () => {
  const src = readFileSync(join(process.cwd(), 'lib/api/handlers/material-issues.ts'), 'utf8');

  it('menolak kalau shortageCount > 0 tanpa override + alasan', () => {
    expect(src).toMatch(/if \(shortageCount > 0 && \(!overrideShortage \|\| !overrideShortageNote\)\)/);
  });

  it('tidak lagi hard-block setiap shortage tanpa syarat (fix lama sudah tidak ada)', () => {
    expect(src).not.toMatch(/if \(shortageCount > 0\) \{\s*\n\s*return err\(/);
  });

  it('menyimpan jejak shortageOverride (siapa, kapan, alasan, baris kurang) di dokumen', () => {
    expect(src).toMatch(/const shortageOverride = shortageCount > 0 \? \{/);
    expect(src).toMatch(/reason: overrideShortageNote/);
    // netReadiness (bukan lagi readiness mentah) — commit lain menambahkan
    // applyConsumptionToRequirementLines() setelah fix ini, memperhitungkan
    // konsumsi Issue lain yang paralel; shortageLines tetap difilter dari sana.
    expect(src).toMatch(/shortageLines: netReadiness\.lines\.filter\(\(l\) => l\.shortage\)/);
    expect(src).toMatch(/\.\.\.\(shortageOverride \? \{ shortageOverride \} : \{\}\)/);
  });

  it('mencatat alasan override ke riwayat dokumen (terlihat di dialog Riwayat)', () => {
    expect(src).toMatch(/diproses meski kurang \$\{shortageCount\} item/);
  });

  it('mencatat override ke audit log', () => {
    expect(src).toMatch(/metadata: \{ shortageOverride: true, shortageCount, reason: overrideShortageNote \}/);
  });
});
