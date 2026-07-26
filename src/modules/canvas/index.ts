import type { Module } from '../types.js';
import { canvasStatusLine, registerCanvasWatcher, runCanvasPoll } from './canvas.js';
import { canvasConfig } from './config.js';

export const canvasModule: Module = {
  id: 'canvas',
  register(host) {
    canvasConfig({
      selftest: process.argv.includes('--selftest'),
      baseUrl: process.env.CANVAS_BASE_URL,
      token: process.env.CANVAS_API_TOKEN,
    });

    host.onStart(() => registerCanvasWatcher());
    host.statusLine(() => canvasStatusLine());

    host.addCommand('canvas', 'check Canvas LMS for new items', async (ctx) => {
      await ctx.reply('checking Canvas…');
      await runCanvasPoll({
        force: true,
        reply: async (text) => {
          await ctx.reply(text);
        },
      });
    });
  },
};
