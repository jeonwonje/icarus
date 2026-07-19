import { existsSync } from 'node:fs';
import readline from 'node:readline/promises';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const apiId = Number(process.env.TG_API_ID || (await rl.question('api_id (from my.telegram.org): ')));
const apiHash = process.env.TG_API_HASH || (await rl.question('api_hash: '));

const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
await client.start({
  phoneNumber: () => rl.question('phone number (international format): '),
  password: () => rl.question('2FA password (empty if none): '),
  phoneCode: () => rl.question('code you received: '),
  onError: (e) => console.error(e),
});
console.log('\nLogin ok. Put this in icarus\\.env as TG_SESSION= (one line):\n');
console.log(client.session.save());
await client.disconnect();
process.exit(0);
