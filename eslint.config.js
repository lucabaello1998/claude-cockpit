import globals from 'globals';

// Config minima con un solo objetivo: atrapar identificadores que se usan pero
// no existen en ese alcance. Es el error que dejo la pantalla en negro (una
// prop usada sin estar en la firma del componente) y que Vite no ve, porque el
// archivo es sintacticamente valido y solo revienta al renderizar.
export default [
  {
    files: ['src/renderer/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, React: 'readonly' },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^React$' }],
    },
  },
  {
    files: ['src/main/**/*.cjs', 'electron/**/*.cjs', 'scripts/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: { 'no-undef': 'error' },
  },
];
