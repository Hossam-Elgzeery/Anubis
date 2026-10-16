import { defineConfig } from "eslint/config";
import type { ESLint } from "eslint";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

const hooksPlugin = reactHooks as unknown as NonNullable<
  NonNullable<ConstructorParameters<typeof ESLint>[0]>["overrideConfig"]
> extends Array<infer T>
  ? T extends { plugins?: infer P }
    ? NonNullable<P> extends Record<string, infer V>
      ? V
      : never
    : never
  : never;

export const defaultESLintConfig = defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": hooksPlugin,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-console": "warn",
      "no-debugger": "error",
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "warn",
    },
  },
);
