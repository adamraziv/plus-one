import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.claude/**',
      'node_modules/**',
      'dist/**',
      'coverage/**',
      '.mastra/**',
      'apps/**/*.js',
      'packages/**/*.js',
      'test/**/*.js',
      'vitest.workspace.js',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
