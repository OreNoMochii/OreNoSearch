import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Coverage is scoped to the modules these suites actually target.
      //
      // They cover pure logic and process-level behaviour only, so CI can
      // run them with no Postgres, Redis, Meilisearch, Google credentials
      // or LLM provider.
      //
      // Deliberately out of scope while it is in progress: the ML pipeline
      // (tree scorer, retrieval pipeline, company intel, hybrid engine)
      // and anything needing live infrastructure to exercise.
      include: [
        '**/core/tsquery.ts',
        '**/core/email_address.ts',
        '**/core/schemas.ts',
        '**/utils/rate_limiter.ts',
        '**/utils/python_runner.ts',
      ],
      thresholds: {
        lines: 85,
        functions: 80,
        branches: 80,
      },
    },
  },
});
