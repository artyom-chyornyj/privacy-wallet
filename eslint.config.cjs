const tsParser = require('@typescript-eslint/parser');

module.exports = [
  {
    ignores: [
      'public/libs/**',
      'scripts/**',
      'eslint.config.cjs',
    ],
  },
  ...require('@railgun-reloaded/eslint-config')(),
  {
    files: ['vite.config.ts', 'vitest.config.ts', 'config/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.node.json',
      },
    },
  },
  {
    files: ['**/*.d.ts'],
    rules: {
      'import-x/group-exports': 'off',
      'import-x/exports-last': 'off',
    },
  },
];
