import type { Module } from '../types.js';
import { browserConfig } from './config.js';

export const browserModule: Module = {
  id: 'browser',
  register(host) {
    host.addMcp(
      'browser',
      browserConfig({
        selftest: process.argv.includes('--selftest'),
        raw: process.env.ICARUS_BROWSER_MCP,
      }),
      { when: (j) => !!j.browser },
    );
  },
};
