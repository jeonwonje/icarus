import type { Module } from '../types.js';
import { mailConfig } from './config.js';
import { mailStatusLine, registerMailWatcher } from './watcher.js';

export const mailModule: Module = {
  id: 'mail',
  register(host) {
    mailConfig({
      selftest: process.argv.includes('--selftest'),
      dropDir: process.env.ICARUS_MAIL_DROP,
    });

    host.onStart(() => registerMailWatcher());
    host.statusLine(() => mailStatusLine());
  },
};
