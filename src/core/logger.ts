import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';

export const logger = pino(
  process.stdout.isTTY
    ? { level, transport: { target: 'pino-pretty', options: { colorize: true } } }
    : { level },
);
