/** Client-side visibility untuk menu reset sandbox (MASTER). */
export function isSandboxResetMenuVisible(): boolean {
  if (process.env.NEXT_PUBLIC_ENABLE_SANDBOX_RESET_UI === '0') return false;
  if (process.env.NEXT_PUBLIC_ENABLE_SANDBOX_RESET_UI === '1') return true;
  // Build Docker VPS: NEXT_PUBLIC_DEPLOYMENT_MODE=vps di-bake saat `next build`.
  if (process.env.NEXT_PUBLIC_DEPLOYMENT_MODE === 'vps') return true;
  return process.env.NODE_ENV === 'development';
}
