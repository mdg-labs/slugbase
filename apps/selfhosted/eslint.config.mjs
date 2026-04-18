import eslint from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['public/**', 'node_modules/**'] },
  eslint.configs.recommended,
  {
    files: ['server.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
];
