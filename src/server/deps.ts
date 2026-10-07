/**
 * 本番の部品の組み立て（Supabase・LINE・Claude）。テストは handleEvent に偽物の Deps を渡す。
 * 回答生成（LLM ＋ 根拠検証）と担当者へのメール通知はまだ無く、それぞれ DB の項目だけの定型文とログで代えている。
 */
import { detectForbiddenTopicByKeyword } from '@/domain/forbidden';
import * as msg from '@/domain/messages';
import { relevantAccess } from '@/domain/search';
import { createSupabaseRepositories } from '@/lib/db';
import { optionalEnv } from '@/lib/env';
import { createLineMessenger } from '@/lib/line/messenger';
import { createAnthropicClient } from '@/lib/llm/client';
import { extractIntentAndSlots } from '@/lib/llm/extract';
import type { Answerer, Deps, Extractor, StaffNotifier } from './handleEvent';

/** DAILY_COST_LIMIT_USD が無いときの1日の API 費用上限（USD） */
const DEFAULT_DAILY_COST_LIMIT_USD = 5;

export function createExtractor(client = createAnthropicClient()): Extractor {
  return async ({ utterance, slots, shown, now }) => {
    const out = await extractIntentAndSlots({
      utterance,
      slots,
      now,
      client,
      shown: shown.map(({ position, property }) => {
        const access = relevantAccess(property, slots.area?.value);
        return {
          position,
          name: property.name,
          rent: property.rent,
          station: access.station,
          walkMin: access.walkMin,
          layout: property.layout,
        };
      }),
    });
    // 抽出に2回失敗して offTopic に倒れたときだけ、禁止トピックを語で拾う安全網をかける
    const forbidden = out.fallback ? detectForbiddenTopicByKeyword(utterance) : null;
    const result = forbidden ? { ...out.result, intent: 'handoff' as const, forbiddenTopic: forbidden } : out.result;
    return { result, latencyMs: out.latencyMs, costUsd: out.costUsd, model: out.model };
  };
}

/**
 * 回答生成の仮実装: 対象物件の詳細を DB の項目だけで返す（推測で補わないので根拠検証は常に ok）。
 * Week 2 で LLM の回答生成（tool use）＋後段の根拠検証に差し替える
 */
export const detailAnswerer: Answerer = async ({ targets }) => ({
  text: targets.map((t) => msg.propertyDetail(t.property, t.position)).join('\n\n'),
  verification: 'ok',
  latencyMs: 0,
  costUsd: 0,
});

/** 担当者通知の仮実装（Week 3 で Resend のメールに差し替える）。個人情報はログに出さない */
export const logNotifier: StaffNotifier = {
  async viewingRequested(info) {
    console.log(
      `[notify] 内見の仮受付 id=${info.viewingRequestId} 候補=${info.candidateTimes.length}件 時間外=${info.receivedOutsideHours}`,
    );
  },
};

export function createProductionDeps(): Deps {
  const limit = Number(optionalEnv('DAILY_COST_LIMIT_USD') ?? DEFAULT_DAILY_COST_LIMIT_USD);
  return {
    repos: createSupabaseRepositories(),
    messenger: createLineMessenger(),
    extract: createExtractor(),
    answer: detailAnswerer,
    notifier: logNotifier,
    clock: () => new Date(),
    dailyCostLimitUsd: Number.isFinite(limit) ? limit : DEFAULT_DAILY_COST_LIMIT_USD,
  };
}
