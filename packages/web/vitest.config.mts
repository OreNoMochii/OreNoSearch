import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      // Pure logic only — no DOM, no network, no component rendering.
      include: ['**/searchClient.ts'],
    },
  },
});
