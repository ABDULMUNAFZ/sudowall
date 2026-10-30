import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      // Vendored, minified third-party code (GSAP), checked as shipped.
      'apps/site/vendor/**',
      '**/coverage/**',
      '**/.turbo/**',
      'planning/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'release/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // The web app has its own tsconfigs: DOM code in src, Node code for Vite and Playwright.
    files: ['apps/web-ui/**/*.ts', 'apps/web-ui/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['apps/web-ui/tsconfig.json', 'apps/web-ui/tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['apps/web-ui/src/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
