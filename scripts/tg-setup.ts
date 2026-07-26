import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { writeTelegramEnvAtomic } from '../src/modules/tg-archive/setupEnv.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const envPath = path.join(ROOT, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

try {
  const apiId = Number(
    process.env.TG_API_ID || (await rl.question('Telegram api_id (my.telegram.org): ')),
  );
  const apiHash =
    process.env.TG_API_HASH || (await rl.question('Telegram api_hash: ')).trim();
  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
    throw new Error('api_id must be a positive integer and api_hash must not be empty');
  }
  const login = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 3,
  });
  await login.start({
    phoneNumber: () => rl.question('Phone number (international format): '),
    password: () => rl.question('2FA password (empty if none): '),
    phoneCode: () => rl.question('Code received in Telegram: '),
    onError: (error) => console.error(`Telegram login: ${error.message}`),
  });
  const session = login.session.save() as string;
  await login.disconnect();

  const verify = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3,
  });
  await verify.connect();
  if (!(await verify.checkAuthorization())) throw new Error('saved session did not verify');
  const me = await verify.getMe();
  await verify.disconnect();

  writeTelegramEnvAtomic(envPath, { apiId, apiHash, session });
  console.log(`Telegram connected as ${me.username ? `@${me.username}` : me.firstName ?? 'user'}.`);
  console.log('Credentials saved to .env without printing secrets. Send /restart to Icarus.');
} finally {
  rl.close();
}
