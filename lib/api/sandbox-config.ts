/** Kill-switch & guard untuk UI reset sandbox (MASTER only). */

export const SANDBOX_CONFIRM_PHRASE = 'RESET SANDBOX';

export function isSandboxResetUiEnabled(): boolean {
  if (process.env.ENABLE_SANDBOX_RESET_UI === '0' || process.env.NEXT_PUBLIC_ENABLE_SANDBOX_RESET_UI === '0') {
    return false;
  }
  if (
    process.env.ENABLE_SANDBOX_RESET_UI === '1' ||
    process.env.NEXT_PUBLIC_ENABLE_SANDBOX_RESET_UI === '1'
  ) {
    return true;
  }
  return process.env.NODE_ENV === 'development';
}

/** `null` = boleh dijalankan; string = pesan error untuk client. */
export function getSandboxResetBlockReason(): string | null {
  if (!isSandboxResetUiEnabled()) {
    return 'Fitur reset sandbox dinonaktifkan. Set ENABLE_SANDBOX_RESET_UI=1 (dan NEXT_PUBLIC_ENABLE_SANDBOX_RESET_UI=1 untuk menu).';
  }
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SANDBOX_RESET !== '1') {
    return 'Production: set ALLOW_SANDBOX_RESET=1 untuk mengizinkan reset sandbox.';
  }
  return null;
}

export function getSalesDbName(): string {
  return process.env.SALES_DB_NAME || 'kasir_db';
}
