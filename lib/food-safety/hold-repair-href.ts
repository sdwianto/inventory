/**
 * Gelombang C — deep-link HOLD → Temuan / unggah bukti follow-up.
 */

export function buildHaccpHoldRepairHrefs(opts: {
  caseId?: string;
  batchId?: string;
  followUpId?: string;
}): { temuanHref: string; followUpHref: string } {
  const temuan = new URLSearchParams();
  if (opts.caseId) temuan.set('caseId', opts.caseId);
  if (opts.batchId) temuan.set('batch', opts.batchId);
  const fu = new URLSearchParams();
  if (opts.caseId) fu.set('caseId', opts.caseId);
  fu.set('upload', '1');
  if (opts.followUpId) fu.set('followUpId', opts.followUpId);
  const temuanQs = temuan.toString();
  return {
    temuanHref: temuanQs ? `/kitchen-assurance/temuan?${temuanQs}` : '/kitchen-assurance/temuan',
    followUpHref: `/kitchen-assurance/follow-up?${fu.toString()}`,
  };
}
