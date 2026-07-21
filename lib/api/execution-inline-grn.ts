/** VPS vs inline GRN job processing (EE-9D / EE-10). */

import { shouldProcessJobInline } from '@/lib/api/execution-wave';
import { JOB_TYPES } from '@/lib/api/bg-jobs';

/** Jangan force Vercel — job yang menunggu Sales memakan slot/lambda. Opt-in via EXECUTION_INLINE_GRN=1. */
export function shouldProcessGrnJobInline(): boolean {
  if (process.env.EXECUTION_INLINE_GRN === '1') return true;
  return shouldProcessJobInline(JOB_TYPES.GRN_INVOICE_SYNC);
}
