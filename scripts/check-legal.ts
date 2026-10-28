/**
 * 製品の本番ビルドで、プライバシーポリシーと利用規約の発注者が埋める欄が未記入なら落とす（`npm run build` の prebuild。意思決定ログ41）。
 * 判定は src/app/_legal/operator.ts の `productLegalProblems`。公開デモの本番（DEMO_MODE=1）・Preview・CI・手元のビルドは素通り。
 */
import { productLegalProblems } from '../src/app/_legal/operator';

const problems = productLegalProblems({ VERCEL_ENV: process.env.VERCEL_ENV, DEMO_MODE: process.env.DEMO_MODE });

if (problems.length > 0) {
  console.error('製品の本番ビルドを止めました（プライバシーポリシー・利用規約）:');
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
