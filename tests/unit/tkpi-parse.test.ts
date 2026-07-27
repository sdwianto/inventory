import { describe, expect, it } from 'vitest';
import {
  parseIdNumber,
  parseTkpiCsv,
  parseAkgCsv,
  tkpiToNutritionFacts,
} from '@/lib/food-production/tkpi-parse';
import { contributionFromProduct, AKG_PROFILES } from '@/lib/food-production/nutrition';

describe('tkpi-parse', () => {
  it('parses Indonesian numbers', () => {
    expect(parseIdNumber('11,3')).toBe(11.3);
    expect(parseIdNumber('1.244')).toBe(1244);
    expect(parseIdNumber('-')).toBeNull();
    expect(parseIdNumber('1.000')).toBe(1000);
  });

  it('parses TKPI csv sample', () => {
    const csv = [
      'h1',
      'h2',
      'h3',
      'h4',
      '1;BP019;Beras Cerdas;11,3;350;2,7;1,1;82,3;6,2;2,6;28;351;2,9;358;568;0,2;0,9;-;0,4;-;0,02;0,2;0,3;0,2;100;Olahan;Umbi;BKP',
      '5;ER012;Buah Naga Merah, segar;85,7;71;1,7;3,1;9,1;3,2;0,4;13;14;0,4;128;128;-;0,4;-;-;-;0,5;0,3;0,5;1;67;Tunggal;Buah;BKP',
    ].join('\n');
    const rows = parseTkpiCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].kode).toBe('BP019');
    expect(rows[0].energiKcal).toBe(350);
    expect(rows[0].bddPct).toBe(100);
    expect(rows[1].bddPct).toBe(67);
    const facts = tkpiToNutritionFacts(rows[1], 100);
    const c = contributionFromProduct(1, facts);
    // 100g × 67% BDD → 67g → 0.67 × 71 ≈ 47.57
    expect(c?.energiKcal).toBeCloseTo(47.57, 1);
  });

  it('loads MBG meal AKG profiles (Tabel 2), not daily CSV', () => {
    expect(AKG_PROFILES.PORSI_KECIL.energiKcal).toBe(340);
    expect(AKG_PROFILES.PORSI_BESAR.energiKcal).toBe(762);
    expect(AKG_PROFILES.ANAK_SD.energiKcal).toBe(340);
    expect(AKG_PROFILES.PORSI_KECIL.proteinG).toBe(6.4);
    expect(AKG_PROFILES.PORSI_KECIL.lemakG).toBe(11.2);
    expect(AKG_PROFILES.PORSI_KECIL.karbohidratG).toBe(52);
  });

  it('still parses legacy AKG csv macros (utility only)', () => {
    const csv = [
      'Bayi / Anak;;;;;;;;;;;',
      '7 - 9 tahun;27;130;1650;40;55;10;0,9;250;23;1650;7 - 9 tahun;500;15;8;25;0,9;0,9;10;4;1;12;300;2;375;45;7 - 9 tahun;1000;500;135;1000;3200',
      'Laki-laki;Berat;Tinggi',
      '19 - 29 tahun;60;168;2650;65;75;17;1,6;430;37;2500;19 - 29 tahun;650;15;15;65;1,2;1,3;16;5;1,3;30;400;4;550;90;19 - 29 tahun;1000;700;360;1500;4700',
    ].join('\n');
    const profiles = parseAkgCsv(csv);
    const anak = profiles.find((p) => p.key === 'ANAK_7_9_TAHUN');
    expect(anak?.energiKcal).toBe(1650);
    expect(anak?.natriumMg).toBe(1000);
  });
});
