/**
 * Gelombang E — deep-link pilar Audit → Setup / Operasi / Temuan / Wizard.
 */

export type HaccpWizardStepQuery = 'A' | 'B' | 'C' | 'D' | 'E';

export function buildHaccpWizardHref(opts?: {
  planId?: string | null;
  step?: HaccpWizardStepQuery;
  wizard?: boolean;
}): string {
  const p = new URLSearchParams();
  const planId = String(opts?.planId || '').trim();
  if (planId) p.set('planId', planId);
  else if (opts?.wizard !== false) p.set('wizard', '1');
  if (opts?.step) p.set('step', opts.step);
  const qs = p.toString();
  return qs ? `/food-production/haccp-plan?${qs}` : '/food-production/haccp-plan';
}

export function auditPillarHref(
  key: string,
  opts?: { planId?: string | null },
): string {
  switch (key) {
    case 'bgn_prp':
      return '/kitchen-assurance/setup';
    case 'haccp_plan':
      return buildHaccpWizardHref({ planId: opts?.planId, wizard: true });
    case 'haccp_verification':
      return buildHaccpWizardHref({ planId: opts?.planId, step: 'E' });
    case 'haccp_training':
      return buildHaccpWizardHref({ planId: opts?.planId, step: 'E' });
    case 'open_holds':
      return '/kitchen-assurance/temuan';
    case 'haccp_fail_window':
      return '/kitchen-assurance/operasi';
    default:
      return '/kitchen-assurance/audit';
  }
}

/** PRP tanpa bukti + pilar non-PRP yang belum READY. */
export function countAuditOpenItems(input: {
  prpCovered?: number | null;
  prpTotal?: number | null;
  extraOpenPillars?: number | null;
}): number {
  const prpGap = Math.max(0, (input.prpTotal ?? 0) - (input.prpCovered ?? 0));
  return prpGap + Math.max(0, input.extraOpenPillars ?? 0);
}
