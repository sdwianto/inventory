/** Pesan error API aman untuk client — detail teknis hanya di server log. */

export function publicApiErrorMessage(e: unknown, fallback = 'Terjadi kesalahan server'): string {
  if (process.env.NODE_ENV !== 'production') {
    return e instanceof Error ? e.message : fallback;
  }
  const msg = e instanceof Error ? e.message : '';
  if (msg.includes('MONGO_URL') || msg.includes('SESSION_SECRET') || msg.includes('Bootstrap master')) {
    return msg;
  }
  if (msg.includes('ECONNREFUSED') || msg.includes('connect')) {
    return 'Database tidak terjangkau. Hubungi administrator.';
  }
  return fallback;
}
