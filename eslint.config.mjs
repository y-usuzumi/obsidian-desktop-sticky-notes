import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" }
    },
    settings: {
      // Obsidian supplies the electron module at runtime, the same way it
      // supplies "obsidian", so it is not a package this plugin installs.
      "import/core-modules": ["electron"]
    },
    rules: {
      // Only Obsidian's own @electron/remote may be used (see obsidianRemote in
      // main.ts). Static imports of the package and its subpaths are refused,
      // type-only ones included (the rule does not see require() or a dynamic
      // import(), which the bundler would leave in place as well). Types come
      // from `typeof import("@electron/remote")`, which loads nothing at runtime.
      "no-restricted-imports": ["error", {
        paths: [{
          name: "@electron/remote",
          message: "Use obsidianRemote() in main.ts; a bundled @electron/remote runs a second callback registry beside Obsidian's."
        }],
        patterns: [{
          group: ["@electron/remote/*"],
          message: "Use obsidianRemote() in main.ts; a bundled @electron/remote runs a second callback registry beside Obsidian's."
        }]
      }]
    }
  }
]);
