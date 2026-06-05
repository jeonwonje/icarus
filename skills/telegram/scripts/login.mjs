// skills/telegram/scripts/login.mjs
// One-time interactive login. Prints a StringSession to paste into ~/.bashrc.
// Requires TELEGRAM_API_ID + TELEGRAM_API_HASH in the environment.
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiId || !apiHash) {
  console.error(
    'Set TELEGRAM_API_ID and TELEGRAM_API_HASH first (from https://my.telegram.org → API development tools).',
  );
  process.exit(1);
}

const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

await client.start({
  phoneNumber: async () => await input.text('Phone number (international, e.g. +82109...): '),
  password: async () => await input.text('2FA password (blank if none): '),
  phoneCode: async () => await input.text('Login code Telegram just sent you: '),
  onError: (err) => console.error(err),
});

console.log('\nLogin OK. Add this line to ~/.bashrc (keep it secret):\n');
console.log(`export TELEGRAM_SESSION='${client.session.save()}'`);
await client.disconnect();
process.exit(0);
