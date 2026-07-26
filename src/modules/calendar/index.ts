import type { Module } from '../types.js';
import { calendarConfig } from './config.js';

export const calendarModule: Module = {
  id: 'calendar',
  register(host) {
    host.addMcp(
      'calendar',
      calendarConfig({
        selftest: process.argv.includes('--selftest'),
        raw: process.env.ICARUS_CALENDAR_MCP,
      }),
    );
  },
};
