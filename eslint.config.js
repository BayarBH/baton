import tseslint from 'typescript-eslint';

export default [{ ignores: ['node_modules', 'dist'] }, ...tseslint.configs.recommended];
