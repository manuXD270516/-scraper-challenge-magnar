// Config plana mínima: TS recomendado + apagar reglas que colisionan con Prettier.
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'output/', 'test/fixtures/', 'docs/'],
  },
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // Cero `any` sin justificación: se permite solo con comentario // eslint-disable-next-line.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
