import type { Module } from '../types.js';
import { browserConfig } from './config.js';

export const browserModule: Module = {
  id: 'browser',
  register() {
    browserConfig({ selftest: process.argv.includes('--selftest') });
  },
};
