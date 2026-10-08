import metarhia from 'eslint-config-metarhia';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/', 'spikes/'] },
  ...metarhia,
  ...tseslint.configs.recommended,
  {
    languageOptions: { sourceType: 'module' },
    rules: {
      // TypeScript resolves names; the core rules misread type-only syntax.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];
