import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    pool: 'forks',
    exclude: ['**/node_modules/**', '**/dist/**', '**/data/**'],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
});
