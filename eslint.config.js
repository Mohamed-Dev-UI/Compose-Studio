import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import figmaPlugin from '@figma/eslint-plugin-figma-plugins';

export default tseslint.config(
  eslint.configs.recommended,
  // @typescript-eslint/recommended-type-checked is too aggressive for
  // widget code...it doesn't seem to like JSX element return values or
  // unbundling the `widget` object for use* hooks. So we'll use
  // tseslint.configs.recommended instead.
  tseslint.configs.recommended,
  {
    plugins: {
      '@figma/figma-plugins': figmaPlugin,
    },
    rules: {
      ...figmaPlugin.configs.recommended.rules,
      // Requires parserOptions.project (typed linting). We lint untyped to keep
      // eslint fast; the rule targets Figma widget code which this plugin does
      // not use.
      '@figma/figma-plugins/ban-deprecated-sync-prop-getters': 'off',
      // allow underscore-prefixing of unused variables
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    ignores: ['code.js', 'dist', 'eslint.config.js'],
  },
  {
    // Build tooling runs under Node.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
);
