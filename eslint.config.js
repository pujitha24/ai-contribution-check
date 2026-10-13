import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'lib/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Stylistic; short arrow bodies such as `(m) => core.info(m)` are clearer.
      '@typescript-eslint/no-confusing-void-expression': 'off'
    }
  },
  {
    // Test fakes implement async interfaces without awaiting anything.
    files: ['__tests__/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' }
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked
  }
)
