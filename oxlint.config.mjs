import appiumConfig, {defineConfig, ignorePatterns} from '@appium/oxc-config/oxlint';

export default defineConfig({
  extends: [appiumConfig],
  ignorePatterns: [...ignorePatterns],
  rules: {
    'no-console': 'off',
  },
  overrides: [
    {
      // Serialized into the walkthrough viewer page and run in the browser.
      files: ['src/walkthrough/overlay.ts'],
      env: {browser: true},
    },
  ],
});
