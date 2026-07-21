/** Kill-switch & guard untuk UI reset sandbox (MASTER only). */

export const SANDBOX_CONFIRM_PHRASE = 'RESET SANDBOX';

function isVpsDeployment(): boolean {
  return String(process.env.DEPLOYMENT_MODE || '').toLowerCase() === 'vps';
}

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
  // VPS Docker: aktifkan UI reset untuk uji/coba (purge tetap butuh ALLOW_SANDBOX_RESET).
  if (isVpsDeployment()) return true;
  return process.env.NODE_ENV === 'development';
}

function isSandboxPurgeAllowedInProduction(): boolean {
  if (process.env.ALLOW_SANDBOX_RESET === '0') return false;
  if (process.env.ALLOW_SANDBOX_RESET === '1') return true;
  // VPS uji coba: boleh purge kecuali di-kill eksplisit dengan ALLOW_SANDBOX_RESET=0.
  return isVpsDeployment();
}

/** `null` = boleh dijalankan; string = pesan error untuk client. */
export function getSandboxResetBlockReason(): string | null {
  if (!isSandboxResetUiEnabled()) {
    return 'Fitur reset sandbox dinonaktifkan. Set ENABLE_SANDBOX_RESET_UI=1 (dan NEXT_PUBLIC_ENABLE_SANDBOX_RESET_UI=1 untuk menu).';
  }
  if (process.env.NODE_ENV === 'production' && !isSandboxPurgeAllowedInProduction()) {
    return 'Production: set ALLOW_SANDBOX_RESET=1 (atau DEPLOYMENT_MODE=vps) untuk mengizinkan reset sandbox.';
  }
  return null;
}

export function getSalesDbName(): string {
  return process.env.SALES_DB_NAME || 'kasir_db';
}

/** Worker purge (server-to-server) — tidak perlu ENABLE_SANDBOX_RESET_UI. */
export function getWorkerSandboxBlockReason(): string | null {
  if (process.env.NODE_ENV === 'production' && !isSandboxPurgeAllowedInProduction()) {
    return 'Production: set ALLOW_SANDBOX_RESET=1 (atau DEPLOYMENT_MODE=vps) untuk purge sandbox via worker.';
  }
  return null;
}
