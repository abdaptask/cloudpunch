// Flat config, ESLint v9.
// See CLAUDE.md for lint conventions.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/target/**',
      '**/*.d.ts',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Config JS files (eslint.config.js, *.config.js) live outside the
        // TypeScript project graphs; permit them through the default project.
        projectService: {
          allowDefaultProject: [
            'eslint.config.js',
            '*.config.js',
            '*.config.mjs',
            'vitest.config.ts',
            'vitest.integration.config.ts',
            'apps/*/vite.config.ts',
            'apps/*/vitest.config.ts',
            'apps/*/vitest.integration.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // Fastify handlers and plugins are typed as async even when the body
      // does not await; this rule fights the framework's model.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Fastify's `.json()` returns unknown; specific-shape asserts in test
      // bodies are load-bearing and hard to route through generics cleanly.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
);
