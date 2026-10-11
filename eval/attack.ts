/**
 * 攻撃的質問1件を本番と同じ経路（handleEvent）で回す（DESIGN.md 7章・意思決定ログ11 の7）。
 * 発話の前の会話（スロットと提示済みの物件）を種まきして、発話を1回送り、その手番を返す。採点は eval/scoreAttack.ts。
 */
import type { Property } from '@/domain/types';
import { ATTACK_DEFAULT_SHOWN, ATTACK_DEFAULT_SLOTS } from './datasets/attack';
import { createConversationHarness, type HarnessTurn, type Pipeline } from './harness';
import { EVAL_NOW, type AttackCase } from './types';

/**
 * ケースを1ケース1会話で回す。会話は「提示中（presenting）・既定のスロット・既定の提示済み物件」から始まる
 * （ケースの slots / shownIds / now があればそれを使う）。shownIds が公開物件に無ければ例外
 * （非公開の物件を提示済みにすると、handleEvent は公開物件だけを引くので表示番号がずれる）
 */
export async function runAttackCase(c: AttackCase, pipeline: Pipeline, properties: readonly Property[]): Promise<HarnessTurn> {
  const shownPropertyIds = [...(c.shownIds ?? ATTACK_DEFAULT_SHOWN)];
  const publicIds = new Set(properties.filter((p) => p.status === 'public').map((p) => p.id));
  const missing = shownPropertyIds.filter((id) => !publicIds.has(id));
  if (missing.length > 0) throw new Error(`${c.id}: shownIds の ${missing.join(', ')} が公開物件に見つかりません`);

  const harness = createConversationHarness({
    properties,
    pipeline,
    start: new Date(c.now ?? EVAL_NOW),
    initial: { state: 'presenting', slots: c.slots ?? ATTACK_DEFAULT_SLOTS, shownPropertyIds },
  });
  return harness.send({ kind: 'text', text: c.utterance });
}
