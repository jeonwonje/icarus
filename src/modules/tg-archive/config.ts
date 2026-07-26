import { z } from 'zod';
import { telegramConfigState } from './setupEnv.js';
import type { TelegramConfigState } from './types.js';

export type TgArchiveConfig = {
  apiId: number;
  apiHash: string;
  session: string;
  configState: TelegramConfigState;
};

let cached: TgArchiveConfig | undefined;

export function getTgArchiveConfig(): TgArchiveConfig {
  if (!cached) throw new Error('tg-archive config not initialized — module must register first');
  return cached;
}

export function tgArchiveConfigState(): TelegramConfigState {
  return getTgArchiveConfig().configState;
}

export function tgArchiveConfig(input: { selftest: boolean }): TgArchiveConfig {
  if (input.selftest) {
    cached = {
      apiId: 1,
      apiHash: 'selftest',
      session: 'selftest',
      configState: 'configured',
    };
    return cached;
  }
  const Env = z.object({
    TG_API_ID: z.coerce.number().int().positive(),
    TG_API_HASH: z.string().min(1),
    TG_SESSION: z.string().min(1),
  });
  const env = Env.parse(process.env);
  const configState = telegramConfigState({
    apiId: env.TG_API_ID,
    apiHash: env.TG_API_HASH,
    session: env.TG_SESSION,
  });
  if (configState !== 'configured') {
    throw new Error('TG_API_ID, TG_API_HASH, and TG_SESSION are all required');
  }
  cached = {
    apiId: env.TG_API_ID,
    apiHash: env.TG_API_HASH,
    session: env.TG_SESSION,
    configState,
  };
  return cached;
}
