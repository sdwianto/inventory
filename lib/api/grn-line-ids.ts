import { v4 as uuidv4 } from 'uuid';

type GrnLineItem = Record<string, unknown> & { lineId?: string };

/** Pastikan setiap baris GRN punya lineId unik (perbaiki data lama dari sales.app). */
export function ensureUniqueLineIds(items: GrnLineItem[] | null | undefined): { items: GrnLineItem[]; changed: boolean } {
  const seen = new Set<string>();
  let changed = false;
  const out = (items || []).map((it) => {
    let lineId = String(it?.lineId || '').trim() || uuidv4();
    if (seen.has(lineId)) {
      lineId = uuidv4();
      changed = true;
    }
    seen.add(lineId);
    if (lineId !== it?.lineId) changed = true;
    return lineId === it?.lineId ? it : { ...it, lineId };
  });
  return { items: out, changed };
}
