/**
 * Daftarkan webhook bot Telegram ke Inventory.
 *
 *   tsx scripts/telegram-set-webhook.ts            # setWebhook ke $NEXT_PUBLIC_BASE_URL/api/telegram/webhook
 *   tsx scripts/telegram-set-webhook.ts --info     # tampilkan status webhook
 *   tsx scripts/telegram-set-webhook.ts --delete   # hapus webhook
 *
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, TELEGRAM_WEBHOOK_SECRET, NEXT_PUBLIC_BASE_URL.
 */

import { getTelegramConfig, telegramApi } from '@/lib/notifications/telegram';
import { getInventoryPublicOrigin } from '@/lib/integration-public-url';

async function main() {
  const cfg = getTelegramConfig();
  if (!cfg) throw new Error('TELEGRAM_BOT_TOKEN dan TELEGRAM_BOT_USERNAME wajib diisi');
  const args = new Set(process.argv.slice(2));

  if (args.has('--info')) {
    const info = await telegramApi<Record<string, unknown>>('getWebhookInfo', {});
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  if (args.has('--delete')) {
    await telegramApi('deleteWebhook', { drop_pending_updates: true });
    console.log('Webhook dihapus');
    return;
  }

  if (!cfg.webhookSecret || !/^[A-Za-z0-9_-]{16,256}$/.test(cfg.webhookSecret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET wajib: 16–256 karakter [A-Za-z0-9_-]');
  }
  const origin = getInventoryPublicOrigin();
  if (!origin.startsWith('https://')) throw new Error('NEXT_PUBLIC_BASE_URL harus https:// (syarat Telegram)');
  const url = `${origin}/api/telegram/webhook`;
  await telegramApi('setWebhook', {
    url,
    secret_token: cfg.webhookSecret,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
  console.log(`Webhook terpasang: ${url} (bot @${cfg.botUsername})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
