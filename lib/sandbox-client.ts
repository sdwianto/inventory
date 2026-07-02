/** Client-side visibility untuk menu reset sandbox. */
export function isSandboxResetMenuVisible(): boolean {
  if (process.env.NEXT_PUBLIC_ENABLE_SANDBOX_RESET_UI === '0') return false;
  if (process.env.NEXT_PUBLIC_ENABLE_SANDBOX_RESET_UI === '1') return true;
  return process.env.NODE_ENV === 'development';
}
