/** Server-only Kitchen Assurance document numbers. */

import { nextDocNumber } from '@/lib/api/document-sequence';
import { KA_DOC_PREFIX, type KaDocType } from '@/lib/kitchen-assurance/document';

export async function nextKaDocNumber(
  db: Parameters<typeof nextDocNumber>[0],
  tenantId: string | null | undefined,
  docType: KaDocType,
): Promise<string> {
  return nextDocNumber(db, tenantId, docType, KA_DOC_PREFIX[docType]);
}
