import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  parseActionItems,
  parseMeetingMaterials,
  normalizeMeetingLabelKey,
  countOpenActionItems,
  MAX_MEETING_MATERIALS,
  MAX_MEETING_PHOTOS,
  isAllowedHttpUrl,
} from '@/lib/kitchen-assurance/meeting-record';

describe('meeting-record domain', () => {
  it('normalizes topic key like recipe nama', () => {
    expect(normalizeMeetingLabelKey('  HACCP  Review ')).toBe('haccp review');
  });

  it('parses action items and counts open', () => {
    const items = parseActionItems([
      { text: 'Follow up vendor', picName: 'Ayu', dueDate: '2026-09-20', status: 'OPEN' },
      { text: 'Update SOP', picName: 'Budi', status: 'CLOSED' },
    ]);
    expect('error' in items).toBe(false);
    if ('error' in items) return;
    expect(items).toHaveLength(2);
    expect(countOpenActionItems(items)).toBe(1);
  });

  it('rejects invalid action due date', () => {
    const bad = parseActionItems([{ text: 'x', dueDate: '20-09-2026' }]);
    expect(bad).toEqual({ error: expect.stringContaining('due date') });
  });

  it('parses LINK materials and rejects non-http', () => {
    expect(isAllowedHttpUrl('https://youtu.be/abc')).toBe(true);
    expect(isAllowedHttpUrl('ftp://x')).toBe(false);
    const ok = parseMeetingMaterials([
      { kind: 'LINK', title: 'Demo', url: 'https://youtu.be/abc' },
      { kind: 'FILE', title: 'SOP.pdf', url: '/api/media/t/sop.pdf', originalName: 'SOP.pdf' },
    ]);
    expect('error' in ok).toBe(false);
    if ('error' in ok) return;
    expect(ok).toHaveLength(2);
    expect(ok[0].kind).toBe('LINK');
    expect(ok[1].kind).toBe('FILE');

    const bad = parseMeetingMaterials([{ kind: 'LINK', url: 'javascript:alert(1)' }]);
    expect(bad).toEqual({ error: expect.stringContaining('http') });
  });

  it(`caps materials at ${MAX_MEETING_MATERIALS}`, () => {
    const tooMany = Array.from({ length: MAX_MEETING_MATERIALS + 1 }, (_, i) => ({
      kind: 'LINK',
      url: `https://example.com/${i}`,
    }));
    const res = parseMeetingMaterials(tooMany);
    expect(res).toEqual({ error: expect.stringContaining(String(MAX_MEETING_MATERIALS)) });
  });

  it('exposes MAX_MEETING_PHOTOS = 5', () => {
    expect(MAX_MEETING_PHOTOS).toBe(5);
  });
});

describe('meeting-record wiring smoke', () => {
  it('route-dispatch registers meeting-records and meeting-topics', () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/api/route-dispatch.ts'), 'utf8');
    expect(src).toContain("'meeting-records'");
    expect(src).toContain("'meeting-topics'");
  });

  it('AppShell + KA_OPS_ROUTES include meeting-records', () => {
    const shell = readFileSync(resolve(process.cwd(), 'components/AppShell.tsx'), 'utf8');
    expect(shell).toContain('/kitchen-assurance/meeting-records');
    expect(shell).toContain('Meeting Record');
    const kaBlock = shell.slice(shell.indexOf('const KA_OPS_ROUTES'), shell.indexOf('const LOGISTICS_ROUTES'));
    expect(kaBlock).toContain('/kitchen-assurance/meeting-records');
  });

  it('page exists and uses PhotoUploadField + materials', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'app/kitchen-assurance/meeting-records/page.tsx'),
      'utf8',
    );
    expect(src).toContain('PhotoUploadField');
    expect(src).toContain('Bahan meeting');
    expect(src).toContain('downloadMeetingRecordPdf');
    expect(src).toContain('meeting-topics');
  });

  it('media handler serves office + video MIME', () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/api/handlers/media.ts'), 'utf8');
    expect(src).toContain('application/pdf');
    expect(src).toContain('video/mp4');
    expect(src).toContain('pptx');
  });

  it('handler uses resolveOperationalScope destructuring (tenant isolation)', () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/api/handlers/meeting-records.ts'), 'utf8');
    expect(src).toMatch(/const \{ denied, scopeAuth/);
    expect(src).toContain('auth?.name || auth?.email');
    expect(src).toContain('resolveKitchenNama');
    expect(src).not.toMatch(/const scopeAuth = resolveOperationalScope/);
  });

  it('media-storage exports storeBase64File', () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/api/media-storage.ts'), 'utf8');
    expect(src).toContain('export async function storeBase64File');
  });

  it('PDF export lists materials section', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'lib/kitchen-assurance/meeting-record-pdf.ts'),
      'utf8',
    );
    expect(src).toContain('Bahan Meeting');
    expect(src).toContain('MEETING_MATERIAL_KIND_LABELS');
  });
});
