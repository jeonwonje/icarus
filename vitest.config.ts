import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['skills/**/*.test.mjs', 'test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
