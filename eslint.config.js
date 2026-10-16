import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config({ ignores: ['node_modules/**', 'dist/**', '.wrangler/**'] }, js.configs.recommended, ...ts.configs.recommended, {
  files: ['**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' }
}, { files: ['scripts/*.mjs'], languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly', fetch: 'readonly', AbortSignal: 'readonly' } } });
