import eslint from '@eslint/js';
import globals from 'globals';

/** Lint hand-maintained entrypoints only (assembled bundles under publish/ and dist/ are ignored). */
export default [
  { ignores: ['**/dist/**', '**/publish/**', 'node_modules/**'] },
  eslint.configs.recommended,
  {
    files: ['types/**/*.js', 'backend/index.js', 'frontend/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
];
