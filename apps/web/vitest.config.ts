import { defineConfig } from 'vitest/config';

// Unit tests cover pure logic only (no DOM), so no plugins are needed here.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
});
