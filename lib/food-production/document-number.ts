/** Server-only Food Production document numbers (Mongo sequence). */

import { nextDocNumber } from '@/lib/api/document-sequence';
import { FP_DOC_PREFIX, type FpDocType } from '@/lib/food-production/document';

export { nextDocNumber };

export async function nextFpDocNumber(
  db: Parameters<typeof nextDocNumber>[0],
  tenantId: string | null | undefined,
  docType: FpDocType,
): Promise<string> {
  return nextDocNumber(db, tenantId, docType, FP_DOC_PREFIX[docType]);
}
