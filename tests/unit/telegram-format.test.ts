import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatTelegramMessage } from '@/lib/notifications/telegram';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('formatTelegramMessage', () => {
  const input = { title: 'PO <A> datang besok', body: 'Telur & "Salak"', link: '/pembelian-po?highlight=1' };

  it('tautan hanya untuk origin https publik', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://inv.example.com/');
    expect(formatTelegramMessage(input)).toContain('<a href="https://inv.example.com/pembelian-po?highlight=1">');

    for (const origin of ['http://localhost:3001', 'https://localhost', 'https://10.0.0.5', 'http://inv.example.com', '']) {
      vi.stubEnv('NEXT_PUBLIC_BASE_URL', origin);
      vi.stubEnv('VERCEL_URL', '');
      expect(formatTelegramMessage(input)).not.toContain('<a ');
    }
  });

  it('escape HTML judul & isi', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', '');
    vi.stubEnv('VERCEL_URL', '');
    expect(formatTelegramMessage(input)).toBe('<b>PO &lt;A&gt; datang besok</b>\n\nTelur &amp; &quot;Salak&quot;');
  });
});
