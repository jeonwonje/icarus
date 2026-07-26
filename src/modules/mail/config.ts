import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');

export type MailConfig = {
  dropDir: string;
};

let cached: MailConfig | undefined;

export function getMailConfig(): MailConfig {
  if (!cached) throw new Error('mail config not initialized — module must register first');
  return cached;
}

export function mailConfig(input: { selftest: boolean; dropDir?: string }): MailConfig {
  if (input.selftest) {
    cached = { dropDir: path.join(ROOT, 'state', 'selftest-mail-drop') };
    return cached;
  }
  const dropDir = input.dropDir ?? process.env.ICARUS_MAIL_DROP ?? '';
  if (!dropDir) throw new Error('ICARUS_MAIL_DROP is required');
  cached = { dropDir };
  return cached;
}
