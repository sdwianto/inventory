import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('PhotoUploadField ImageZoom (portal organoleptik pattern)', () => {
  it('PhotoUploadField uses ImageZoom for click-to-enlarge', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'components/maintenance/PhotoUploadField.tsx'),
      'utf8',
    );
    expect(src).toContain("from '@/components/ui/image-zoom'");
    expect(src).toMatch(/<ImageZoom\b/);
    expect(src).toMatch(/Hapus foto/);
  });

  it('ImageZoom mirrors portal: portal overlay, Esc, body scroll lock, Perbesar hint', () => {
    const src = readFileSync(resolve(process.cwd(), 'components/ui/image-zoom.tsx'), 'utf8');
    expect(src).toMatch(/createPortal/);
    expect(src).toMatch(/document\.body\.style\.overflow/);
    expect(src).toMatch(/Escape/);
    expect(src).toMatch(/Perbesar/);
    expect(src).toMatch(/group-hover:scale-125/);
    expect(src).toMatch(/backdrop-blur-sm/);
    expect(src).toMatch(/max-h-\[90vh\]/);
  });
});
