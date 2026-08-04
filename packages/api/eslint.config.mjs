// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'eslint.config.mjs'] },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // ── Rules that guard the defects fixed in this branch ──────────
            // B18: an unawaited async call whose rejection kills the process.
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            // B10: `await logDebug(...)` on a synchronous function.
            '@typescript-eslint/await-thenable': 'error',
            // B7 class: reading unvalidated data off an `any`.
            //
            // These are WARNINGS rather than errors deliberately. 135 of them
            // remain in pre-existing surfaces (ScreeningAgent prompt handling,
            // postgres_repo query building, GoogleSheetsService), and they are
            // type-safety debt rather than live defects. Keeping them visible
            // under a descending --max-warnings cap makes the debt shrink
            // monotonically without blocking work on unrelated code.
            //
            // The rules above that catch actual runtime bugs stay as errors and
            // pass at zero.
            '@typescript-eslint/no-unsafe-member-access': 'warn',
            '@typescript-eslint/no-unsafe-assignment': 'warn',
            '@typescript-eslint/no-unsafe-argument': 'warn',
            '@typescript-eslint/no-unsafe-call': 'warn',
            '@typescript-eslint/no-unsafe-return': 'warn',
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/unbound-method': 'warn',

            // B1: the import that made shell injection possible in the first place.
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        {
                            name: 'child_process',
                            importNames: ['exec', 'execSync'],
                            message:
                                'exec/execSync interpolate into a shell. Use utils/python_runner.ts (spawn with an argv array) instead — see B1.',
                        },
                    ],
                },
            ],

            // ── General hygiene ────────────────────────────────────────────
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            'no-console': ['warn', { allow: ['error', 'warn'] }],
            eqeqeq: ['error', 'always'],
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
    {
        // Config module writes to stderr before the logger exists.
        files: ['src/config/**'],
        rules: { 'no-console': 'off' },
    },
);
