import type { Module } from '../types.js';
import { calendarConfig } from './config.js';

export const calendarModule: Module = {
  id: 'calendar',
  register() {
    calendarConfig({ selftest: process.argv.includes('--selftest') });
  },
};
