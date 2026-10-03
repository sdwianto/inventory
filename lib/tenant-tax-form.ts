export interface TenantTaxForm {
  pkp: boolean;
  /** YYYY-MM-DD (WIB) atau '' */
  pkpSejak: string;
}

export const EMPTY_TENANT_TAX_FORM: TenantTaxForm = { pkp: false, pkpSejak: '' };

export function taxFormFromSettings(raw: unknown): TenantTaxForm {
  const t = (raw || {}) as { pkp?: boolean; pkpSejak?: string | null };
  const sejak = t.pkpSejak ? new Date(t.pkpSejak) : null;
  const wib = sejak && !Number.isNaN(sejak.getTime())
    ? new Date(sejak.getTime() + 7 * 3600_000).toISOString().slice(0, 10)
    : '';
  return { pkp: t.pkp === true, pkpSejak: wib };
}

export function taxFormToBody(f: TenantTaxForm): { pkp: boolean; pkpSejak: string | null } {
  return { pkp: f.pkp, pkpSejak: f.pkp && f.pkpSejak ? f.pkpSejak : null };
}
