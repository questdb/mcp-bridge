import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: ["dist", "node_modules"],
  },
  {
    files: ["src/**/*.{ts,js}"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
)
