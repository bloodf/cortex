import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      // only-throw-error (below) is type-aware; projectService gives the parser
      // the type info it needs without enabling the rest of the type-checked
      // ruleset. Without this, eslint errors on every file.
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/only-throw-error": [
        "error",
        {
          allow: [
            // MP-020: TanStack Router redirect Response
            { from: "package", name: "Redirect", package: "@tanstack/react-router" },
            // MP-020: TanStack Router not-found error
            { from: "package", name: "NotFoundError", package: "@tanstack/router-core" },
            // MP-020: native Response (server-function gate)
            { from: "lib", name: "Response" },
          ],
        },
      ],
    },
  },
  eslintPluginPrettier,
);
