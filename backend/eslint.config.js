// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
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
            // B7: reading unvalidated LLM JSON off an `any`.
            '@typescript-eslint/no-unsafe-member-access': 'error',
            '@typescript-eslint/no-unsafe-assignment': 'warn',
            '@typescript-eslint/no-unsafe-argument': 'warn',
            '@typescript-eslint/no-unsafe-call': 'error',
            '@typescript-eslint/no-explicit-any': 'warn',

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
