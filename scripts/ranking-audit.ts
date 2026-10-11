/**
 * 並び順の監査シートを作る（意思決定ログ18。DESIGN.md 7章「並び順の妥当性」を nDCG の代わりに人の目で確かめる）。
 *
 *   npx tsx scripts/ranking-audit.ts            # docs/並び順の監査.md を書く
 *
 * シナリオ 15 本を台本の正解の抽出（oraclePipeline。API は呼ばない）で回し、新しい検索で物件カードを出した手番ごとに、
 * その時点の条件（優先度つき）と上位 5 件を並べる。スコアの数値は出さない（数値に引きずられずに、条件と物件の中身だけで
 * 「この順はおかしい」を見つけるため）。記入欄に違和感と理由を書き、食い違いは重みをいじらずに記録する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { toJst } from '@/domain/businessHours';
import { formatManYen } from '@/domain/labels';
import { monthlyCost, searchProperties } from '@/domain/search';
import { listConditions } from '@/domain/slots';
import type { Priority, ScoredProperty } from '@/domain/types';
import { loadDemoProperties } from '../eval/data';
import { SCENARIO_CASES } from '../eval/datasets/scenarios';
import { oraclePipeline, runScenario } from '../eval/scenario';

const OUT = path.join('docs', '並び順の監査.md');
const TOP_N = 5;
const PRIORITY_LABEL: Record<Priority, string> = { must: '外せない', want: 'できれば', nice: 'あれば嬉しい' };

function row(rank: number, s: ScoredProperty): string {
  const p = s.property;
  const access = `${s.displayAccess.station} 徒歩${s.displayAccess.walkMin}分`;
  const unmatched = s.unmatched.length > 0 ? s.unmatched.join('・') : '—';
  return `| ${rank} | ${p.name}（${p.id}） | ${formatManYen(monthlyCost(p))}円 | ${access} | ${p.layout}・${p.floor}階・${p.areaSqm}㎡ | ${unmatched} | |`;
}

async function main(): Promise<void> {
  const properties = loadDemoProperties();
  const publicProperties = properties.filter((p) => p.status === 'public');
  const lines: string[] = [
    '# 並び順の監査',
    '',
    `- 作成: \`npx tsx scripts/ranking-audit.ts\`（${toJst(new Date()).date}）。シナリオ 15 本を台本の正解の抽出で回し、新しい検索で物件カードを出した手番の上位 ${TOP_N} 件`,
    '- 並びの規則: 外せない条件で絞り、残りの条件（できれば・あれば嬉しい）の一致度の高い順 → 月額（家賃＋管理費）の安い順 → 物件 ID 順（DESIGN.md 4.2）。スコアの数値はわざと出していない',
    '- 見方: 条件と物件の中身だけを見て、「この順はおかしい」「この物件が上にあるべき」と思ったら、その行の「違和感」に理由を書く。直すかどうかは後で決める（重みをその場でいじらない）',
    '',
  ];
  let points = 0;
  for (const s of SCENARIO_CASES) {
    const run = await runScenario(s, oraclePipeline(s), properties);
    run.turns.forEach((turn, i) => {
      // 新しい検索の1ページ目だけ（「もっと見る」の続きは除く）
      if (turn.cardIds.length === 0 || turn.cardIds[0] !== turn.shownPropertyIds[0]) return;
      const input = turn.input.kind === 'text' ? `「${turn.input.text}」` : turn.input.kind === 'postback' ? `ボタン「${turn.input.label}」` : '友だち追加';
      const conditions = listConditions(turn.slots)
        .map((c) => `${c.label}（${PRIORITY_LABEL[c.priority]}）`)
        .join('／');
      const result = searchProperties(publicProperties, turn.slots);
      lines.push(`## ${s.id} 手番 ${i + 1}: ${input}`, '');
      lines.push(`- 条件: ${conditions}`);
      lines.push(`- 外せない条件を満たす件数: ${result.total} 件`, '');
      lines.push('| 順 | 物件 | 月額 | 駅 | 間取り・階・面積 | 合わない条件 | 違和感（あれば理由） |', '|---:|---|---:|---|---|---|---|');
      result.items.slice(0, TOP_N).forEach((item, k) => lines.push(row(k + 1, item)));
      lines.push('');
      points += 1;
    });
  }
  lines.push('## まとめ（記入）', '', '- 違和感のあった手番:', '- 直すなら（規則・重み・データ）:', '');
  fs.writeFileSync(OUT, `${lines.join('\n')}`, 'utf8');
  console.log(`${OUT} に ${points} か所を書きました`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
