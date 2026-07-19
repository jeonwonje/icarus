import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { cfg } from './config.js';

mkdirSync(cfg.logsDir, { recursive: true });

export const log = pino({
  level: 'debug',
  transport: {
    targets: [
      {
        target: 'pino-roll',
        level: 'debug',
        options: {
          file: path.join(cfg.logsDir, 'icarus'),
          extension: '.log',
          size: '50m',
          limit: { count: 10 },
          mkdir: true,
        },
      },
      // Warnings and errors also go to stdout → service.out.log via the wrapper.
      { target: 'pino/file', level: 'warn', options: { destination: 1 } },
    ],
  },
});
