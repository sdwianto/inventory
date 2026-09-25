import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const handlersDir = path.join(root, 'lib/api/handlers');

describe('route-dispatch registry', () => {
  it('setiap handler terdaftar di route-dispatch atau dipakai handler lain', () => {
    const dispatch = readFileSync(path.join(root, 'lib/api/route-dispatch.ts'), 'utf8');
    const files = readdirSync(handlersDir).filter((f) => f.endsWith('.ts'));
    const sources = new Map(files.map((f) => [f, readFileSync(path.join(handlersDir, f), 'utf8')]));
    const orphans: string[] = [];
    for (const file of files) {
      const name = file.replace(/\.ts$/, '');
      if (!/export async function handle[A-Z]/.test(sources.get(file) || '')) continue;
      if (dispatch.includes(`handlers/${name}'`)) continue;
      const usedByOther = [...sources].some(([other, src]) => (
        other !== file && (src.includes(`'./${name}'`) || src.includes(`handlers/${name}'`))
      ));
      if (!usedByOther) orphans.push(name);
    }
    expect(orphans).toEqual([]);
  });
});
