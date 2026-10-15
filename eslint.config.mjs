import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // scripts/*.js は Node から直接動かす CommonJS
  {
    files: ["scripts/**/*.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // 業務ルールの純関数は決定的に（引き継ぎ書4章の2・5）: 現在時刻は引数で受け取り、乱数は使わない
  {
    files: ["src/domain/**/*.ts"],
    ignores: ["src/domain/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: "src/domain では Date.now() を呼ばない。現在時刻は引数 now で受け取る（引き継ぎ書4章の5）",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "src/domain では引数なしの new Date() を使わない。現在時刻は引数 now で受け取る（引き継ぎ書4章の5）",
        },
        {
          selector: "CallExpression[callee.name='Date']",
          message: "src/domain では Date() を呼ばない。現在時刻は引数 now で受け取る（引き継ぎ書4章の5）",
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: "src/domain では Math.random() を使わない。結果は決定的にする（引き継ぎ書4章の2）",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 並行セッションが作る作業ツリー（中身は別ブランチのリポジトリ全体。ここから lint すると二重に読む）
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
