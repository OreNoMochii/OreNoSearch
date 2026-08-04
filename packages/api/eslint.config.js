import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Directly targets the defect classes found in §2:
      '@typescript-eslint/no-floating-promises': 'error',   // B18
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',          // B10 — `await logDebug()`
      '@typescript-eslint/no-explicit-any': 'error',        // 40+ `catch (e: any)`
      '@typescript-eslint/no-unsafe-member-access': 'error',// B7 — unvalidated LLM JSON
      '@typescript-eslint/no-unsafe-assignment': 'error',
      'no-restricted-imports': ['error', {
        paths: [{ name: 'child_process', importNames: ['exec', 'execSync'],
                  message: 'Use utils/python_runner.ts — exec() enables shell injection (B1).' }],
      }],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
);
