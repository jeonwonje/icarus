import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['skills/**/*.test.mjs'],
    environment: 'node',
  },
});
