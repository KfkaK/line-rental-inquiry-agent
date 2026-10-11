/**
 * シナリオ（複数ターンの台本）15 本。DESIGN.md 7章「到達率」「応答時間とコスト」・7.1 の3、10.1 のデモ動画の流れ。
 * 本番と同じ handleEvent に通す（eval/scenario.ts）。正解の付け方は eval/README.md、物件は架空データ（data/properties.csv）。
 *
 * - text の手番には正解の抽出（extraction）を必ず書く。`npm test` は LLM の代わりにこれを返して全シナリオを回し、
 *   期待（expect）が会話エンジンの仕様と合っているかを確かめる（eval/datasets/scenarios.test.ts）
 * - expect は、本物の LLM で回しても揺れにくい構造的な項目（状態・カード・引き継ぎ・内見・条件・件数・クイックリプライ・
 *   定型文の語）に絞る。LLM の言い回しに依存する includes は使わない（回答生成の文は oracle では定型の仮の文）
 * - 開始時刻は夜と土日（営業時間外）に集中させる: 外 10 本・内 5 本。営業時間（既定 10〜19時・水曜定休）の
 *   開店・閉店の前後 30 分と、日付の切り替わりの前後は避ける（手番は 20 秒間隔で進む）
 * - 件数は架空データ（data/properties.csv ＋ properties.truth.json）の値。データを作り直したらここが落ちる
 *
 * 早見（カレンダー）: 10-15=木 / 10-16=金 / 10-17=土 / 10-18=日 / 10-19=月 / 10-20=火 / 10-21=水（定休日）/ 10-22=木
 */
import type { ExtractionResult, Priority, SlotOp, Tag } from '@/domain/types';
import type { ScenarioCase, ScenarioStep, StepExpectation } from '../types';

// ---------- 台本を書くための小道具 ----------

function ex(partial: Partial<ExtractionResult> = {}): ExtractionResult {
  return { intent: 'conditions', ops: [], targetPositions: [], viewingTimes: [], forbiddenTopic: null, ...partial };
}

const area = (...stations: string[]): SlotOp => ({ op: 'set', key: 'area', value: { stations, wards: [] } });
const rentMax = (yen: number): SlotOp => ({ op: 'set', key: 'rentMax', value: yen });
const addTag = (tag: Tag, priority?: Priority): SlotOp => (priority ? { op: 'addTag', tag, priority } : { op: 'addTag', tag });

const follow = (expect: StepExpectation): ScenarioStep => ({ input: { kind: 'follow' }, expect });
const say = (text: string, extraction: ExtractionResult, expect: StepExpectation, more: Pick<ScenarioStep, 'answer' | 'note'> = {}): ScenarioStep => ({
  input: { kind: 'text', text },
  extraction,
  expect,
  ...more,
});
const tap = (label: string, expect: StepExpectation): ScenarioStep => ({ input: { kind: 'tap', label }, expect });
const tapIndex = (index: number, expect: StepExpectation): ScenarioStep => ({ input: { kind: 'tapIndex', index }, expect });
const card = (button: 'detail' | 'viewing', position: number, expect: StepExpectation): ScenarioStep => ({
  input: { kind: 'card', button, position },
  expect,
});

/**
 * カードの「内見を希望」→ 候補日をクイックリプライで1つ選ぶ → 「この日時で送る」で仮受付まで。
 * `firstDay` は最初の候補日の表示（翌営業日。例: '10月16日(金)'）、`contact` は仮受付の文に出る語（時間外なら連絡日）
 */
function viewingByButtons(position: number, firstDay: string, contact: string[]): ScenarioStep[] {
  return [
    card('viewing', position, { state: 'booking', cards: false, viewing: false, quickReplies: [firstDay] }),
    tapIndex(0, { state: 'booking', viewing: false, quickReplies: ['この日時で送る'], includes: [firstDay] }),
    tap('この日時で送る', { state: 'handed_off', viewing: true, includes: ['受け付けました', 'まだ予約は確定していません', ...contact] }),
  ];
}

// ---------- 15 本 ----------

export const SCENARIO_CASES: ScenarioCase[] = [
  {
    id: 'sc-01',
    title: 'デモ動画の流れ（静か → 0件 → オートロックの緩和 → 2階以上は必須 → 内見）',
    start: '2026-10-15T21:30:00+09:00',
    expectedReach: 'viewing',
    note: 'DESIGN.md 10.1。木曜の夜に始まり、内見の連絡日は翌営業日（金）。全条件 AND では 0 件のまま、優先順位つきなら 7 件 → 5 件',
    steps: [
      follow({ state: 'hearing', includes: ['営業時間外'], quickReplies: ['渋谷'] }),
      say(
        '渋谷か中目黒か代官山で9万まで。バストイレ別は絶対で、静かなところがいいな',
        ex({ ops: [area('渋谷', '中目黒', '代官山'), rentMax(90000), addTag('バストイレ別', 'must'), addTag('静か')] }),
        {
          state: 'presenting',
          cards: true,
          total: { min: 7, max: 7 },
          conditions: [
            { ref: { kind: 'tag', tag: 'バストイレ別' }, priority: 'must' },
            { ref: { kind: 'tag', tag: '静か' }, priority: 'want' },
          ],
        },
      ),
      say('あ、オートロックも絶対ほしい', ex({ ops: [addTag('オートロック', 'must')] }), {
        state: 'hearing',
        cards: false,
        total: { max: 0 },
        includes: ['オートロックを「できれば」にすると', '件増えます'],
        quickReplies: ['条件を変える', 'このままにする'],
      }),
      tap('条件を変える', {
        state: 'presenting',
        cards: true,
        total: { min: 7, max: 7 },
        conditions: [{ ref: { kind: 'tag', tag: 'オートロック' }, priority: 'want' }],
      }),
      say('やっぱり2階以上は必須', ex({ ops: [{ op: 'set', key: 'floorMin', value: 2, priority: 'must' }] }), {
        state: 'presenting',
        cards: true,
        total: { min: 5, max: 5 },
        conditions: [{ ref: { kind: 'slot', key: 'floorMin' }, priority: 'must' }],
      }),
      ...viewingByButtons(1, '10月16日(金)', ['営業時間外', '10月16日(金)に担当者から確定のご連絡']),
    ],
  },

  {
    id: 'sc-02',
    title: 'エリアの追加 → 複数物件の比較質問 → 自由文で内見の日時を2つ伝える',
    start: '2026-10-17T20:40:00+09:00',
    expectedReach: 'viewing',
    note: '土曜の夜。友だち追加を経ずに話しかけ、冒頭で営業時間外を案内される。内見の連絡日は日曜（翌営業日）',
    steps: [
      say('渋谷で9万まで探してます', ex({ ops: [area('渋谷'), rentMax(90000)] }), {
        state: 'presenting',
        cards: true,
        total: { min: 7, max: 7 },
        includes: ['営業時間外'],
      }),
      say(
        'あ、中目黒も見たいな',
        ex({ ops: [area('渋谷', '中目黒')] }),
        { state: 'presenting', cards: true, total: { min: 11, max: 11 }, includes: ['渋谷・中目黒エリア'] },
        { note: '「中目黒も」のように足すときは、今の駅に足した全体を set する（eval/README.md）' },
      ),
      say(
        '1番目と2番目、どっちが駅から近い？',
        ex({ intent: 'propertyQuestion', targetPositions: [1, 2] }),
        { state: 'qa', cards: false, handoff: false },
        { answer: 'answered', note: '提示物件どうしの比較。レコードの徒歩分で答えられる' },
      ),
      say(
        '2番目の内見をお願いします。日曜の14時と月曜の11時で',
        ex({ intent: 'viewingRequest', targetPositions: [2], viewingTimes: ['2026-10-18T14:00', '2026-10-19T11:00'] }),
        { state: 'handed_off', viewing: true, includes: ['受け付けました', '営業時間外', '10月18日(日)に担当者から確定のご連絡'] },
      ),
    ],
  },

  {
    id: 'sc-03',
    title: '1件だけ → 予算を広げる提案を受け入れる → 詳細 → 候補日を2つ選んで内見',
    start: '2026-10-16T22:10:00+09:00',
    expectedReach: 'viewing',
    note: '候補が2件以下（1件）のときの緩和提案（従来型: 予算＋5,000円）。候補日を2つ選ぶと「この日時で送る」を押さなくても仮受付になる',
    steps: [
      say('新宿で七万まで', ex({ ops: [area('新宿'), rentMax(70000)] }), {
        state: 'presenting',
        cards: true,
        total: { min: 1, max: 1 },
        includes: ['予算を7.5万円まで広げると2件増えます'],
        quickReplies: ['条件を変える', 'このままにする'],
      }),
      tap('条件を変える', { state: 'presenting', cards: true, total: { min: 3, max: 3 }, includes: ['3件あります'] }),
      card('detail', 1, {
        state: 'qa',
        cards: false,
        includes: ['空室状況と初期費用の確定額は担当者が確認します'],
        quickReplies: ['この物件の内見を希望'],
      }),
      tap('この物件の内見を希望', { state: 'booking', viewing: false, quickReplies: ['10月17日(土)'] }),
      tapIndex(0, { state: 'booking', viewing: false, quickReplies: ['この日時で送る'] }),
      tapIndex(0, { state: 'handed_off', viewing: true, includes: ['受け付けました', '10月17日(土)に担当者から確定のご連絡'] }),
    ],
  },

  {
    id: 'sc-04',
    title: '27件 → 外せない条件を聞かれてボタンで選ぶ → もっと見る（ボタンと自由文）→ 詳細 → 内見',
    start: '2026-10-18T21:10:00+09:00',
    expectedReach: 'viewing',
    note: '候補が20件を超え、「できれば」の条件があるときだけ、1会話で1回、外せない条件を聞く。選んだ条件は must になって絞られる',
    steps: [
      say(
        '新宿か池袋か渋谷で12万まで。オートロックと2階以上がほしくて、できれば南向きがいいな',
        ex({
          ops: [
            area('新宿', '池袋', '渋谷'),
            rentMax(120000),
            addTag('オートロック'),
            { op: 'set', key: 'floorMin', value: 2 },
            addTag('南向き', 'want'),
          ],
        }),
        {
          state: 'presenting',
          cards: true,
          total: { min: 27, max: 27 },
          includes: ['この中で外せない条件はどれですか？'],
          quickReplies: ['オートロック', '2階以上', '南向き', 'もっと見る'],
        },
      ),
      tap('オートロック', {
        state: 'presenting',
        cards: true,
        total: { min: 13, max: 13 },
        excludes: ['この中で外せない条件はどれですか？'],
        conditions: [{ ref: { kind: 'tag', tag: 'オートロック' }, priority: 'must' }],
        quickReplies: ['もっと見る'],
      }),
      tap('もっと見る', { state: 'presenting', cards: true, quickReplies: ['もっと見る'] }),
      say('他のもお願いします', ex({ intent: 'showMore' }), { state: 'presenting', cards: true, handoff: false }),
      card('detail', 13, { state: 'qa', cards: false, quickReplies: ['この物件の内見を希望'] }),
      tap('この物件の内見を希望', { state: 'booking', viewing: false, quickReplies: ['10月19日(月)'] }),
      tapIndex(0, { state: 'booking', viewing: false, quickReplies: ['この日時で送る'] }),
      tap('この日時で送る', { state: 'handed_off', viewing: true, includes: ['受け付けました', '10月19日(月)に担当者から確定のご連絡'] }),
    ],
  },

  {
    id: 'sc-05',
    title: 'もっと見る → 最初と最後の物件を比べる → 9番目の内見を自由文で',
    start: '2026-10-19T15:00:00+09:00',
    expectedReach: 'viewing',
    note: '営業時間内（月曜の午後）。「もっと見る」で増えた提示リストの末尾（9番目）まで番号で参照できる。仮受付の文に「営業時間外」は出ない',
    steps: [
      say('吉祥寺か荻窪か西荻窪で10万まで', ex({ ops: [area('吉祥寺', '荻窪', '西荻窪'), rentMax(100000)] }), {
        state: 'presenting',
        cards: true,
        total: { min: 9, max: 9 },
        excludes: ['営業時間外'],
        quickReplies: ['もっと見る'],
      }),
      say('もっと見せて', ex({ intent: 'showMore' }), { state: 'presenting', cards: true, handoff: false }),
      say(
        '最初のと最後のだと、どっちが築浅ですか？',
        ex({ intent: 'propertyQuestion', targetPositions: [1, 9] }),
        { state: 'qa', cards: false, handoff: false },
        { answer: 'answered', note: '提示リストは9件（5件＋「もっと見る」の4件）。最後は9番目' },
      ),
      say(
        '9番目の内見をお願いします。火曜の11時と木曜の15時で',
        ex({ intent: 'viewingRequest', targetPositions: [9], viewingTimes: ['2026-10-20T11:00', '2026-10-22T15:00'] }),
        { state: 'handed_off', viewing: true, includes: ['受け付けました', '担当者から確定のご連絡をします'], excludes: ['営業時間外'] },
      ),
    ],
  },

  {
    id: 'sc-06',
    title: '優先度の変更・条件の削除を重ねて探し直す → 水曜をはさんだ候補日から内見',
    start: '2026-10-20T20:15:00+09:00',
    expectedReach: 'viewing',
    note: '「なくてもいい」は nice に下げる（外さない）、「いらない」は外す。全条件 AND（Web サイト式）なら最初から 0 件、優先順位つきなら 7 件。火曜の夜なので、翌営業日は水曜（定休日）を飛ばして木曜',
    steps: [
      say(
        '中目黒か祐天寺か学芸大学で9万まで。オートロックとペット可がほしくて、駅近だと嬉しい',
        ex({
          ops: [
            area('中目黒', '祐天寺', '学芸大学'),
            rentMax(90000),
            addTag('オートロック'),
            addTag('ペット可'),
            { op: 'set', key: 'walkMax', value: 10, priority: 'want' },
          ],
        }),
        {
          state: 'presenting',
          cards: true,
          total: { min: 7, max: 7 },
          conditions: [
            { ref: { kind: 'tag', tag: 'オートロック' }, priority: 'want' },
            { ref: { kind: 'tag', tag: 'ペット可' }, priority: 'want' },
            { ref: { kind: 'slot', key: 'walkMax' }, priority: 'want' },
          ],
        },
      ),
      say('オートロックはなくてもいいかな', ex({ ops: [{ op: 'setTagPriority', tag: 'オートロック', priority: 'nice' }] }), {
        state: 'presenting',
        cards: true,
        total: { min: 7, max: 7 },
        conditions: [{ ref: { kind: 'tag', tag: 'オートロック' }, priority: 'nice' }],
      }),
      say('ペット可はもういらない', ex({ ops: [{ op: 'removeTag', tag: 'ペット可' }] }), {
        state: 'presenting',
        cards: true,
        absent: [{ kind: 'tag', tag: 'ペット可' }],
      }),
      say('徒歩の条件は外してください', ex({ ops: [{ op: 'unset', key: 'walkMax' }] }), {
        state: 'presenting',
        cards: true,
        total: { min: 7, max: 7 },
        absent: [{ kind: 'slot', key: 'walkMax' }],
      }),
      say(
        '1番目を見に行きたいです',
        ex({ intent: 'viewingRequest', targetPositions: [1] }),
        { state: 'booking', viewing: false, quickReplies: ['10月22日(木)'] },
        { note: '日時を言わなかったので候補日を聞かれる。水曜（定休日）は候補に出ない' },
      ),
      tapIndex(0, { state: 'booking', viewing: false, quickReplies: ['この日時で送る'] }),
      tapIndex(0, { state: 'handed_off', viewing: true, includes: ['受け付けました', '10月22日(木)に担当者から確定のご連絡'] }),
    ],
  },

  {
    id: 'sc-07',
    title: '0件 → 隣の駅を含める提案を受け入れる → 自由文で内見の日時を2つ伝える',
    start: '2026-10-16T13:30:00+09:00',
    expectedReach: 'viewing',
    note: '営業時間内（金曜の午後）。0件で、1つ緩めて増える条件が無いときの従来型の緩和（隣の駅）。全条件 AND でも 0 件',
    steps: [
      say('恵比寿か代官山で8万まで', ex({ ops: [area('恵比寿', '代官山'), rentMax(80000)] }), {
        state: 'hearing',
        cards: false,
        total: { max: 0 },
        excludes: ['営業時間外'],
        includes: ['隣の駅（目黒・渋谷・中目黒）も含めると4件増えます'],
        quickReplies: ['条件を変える', 'このままにする'],
      }),
      tap('条件を変える', { state: 'presenting', cards: true, total: { min: 4, max: 4 }, includes: ['4件あります'] }),
      say(
        '1番目の部屋、土曜の14時か日曜の11時に見に行けますか',
        ex({ intent: 'viewingRequest', targetPositions: [1], viewingTimes: ['2026-10-17T14:00', '2026-10-18T11:00'] }),
        { state: 'handed_off', viewing: true, includes: ['受け付けました', '担当者から確定のご連絡をします'], excludes: ['営業時間外'] },
      ),
    ],
  },

  {
    id: 'sc-08',
    title: '定休日（水曜）に始まる → 内見の日時に定休日を言って聞き直される → 1件で送る',
    start: '2026-10-21T14:00:00+09:00',
    expectedReach: 'viewing',
    note: '定休日の昼は営業時間外として扱う。内見は翌営業日（木）以降の営業日だけ受け付け、定休日の候補は捨てて聞き直す。候補日時は1件でも「この日時で送る」で仮受付できる',
    steps: [
      say('高円寺か阿佐ヶ谷で9万まで', ex({ ops: [area('高円寺', '阿佐ケ谷'), rentMax(90000)] }), {
        state: 'presenting',
        cards: true,
        total: { min: 4, max: 4 },
        includes: ['営業時間外'],
      }),
      say(
        '2番目を見たいです。来週の水曜の15時か、今度の土曜の11時はどうですか',
        ex({ intent: 'viewingRequest', targetPositions: [2], viewingTimes: ['2026-10-28T15:00', '2026-10-24T11:00'] }),
        {
          state: 'booking',
          viewing: false,
          includes: ['内見は10月22日(木)以降の営業日でお選びください', '10月24日(土) 11:00'],
          quickReplies: ['この日時で送る'],
        },
      ),
      tap('この日時で送る', { state: 'handed_off', viewing: true, includes: ['受け付けました', '10月22日(木)に担当者から確定のご連絡'] }),
    ],
  },

  {
    id: 'sc-09',
    title: '提示物件への質問（レコードで答えられる）を重ねる → 詳細 → 候補日をボタンで選んで内見',
    start: '2026-10-17T11:30:00+09:00',
    expectedReach: 'viewing',
    note: '営業時間内（土曜の午前）。階数や広さはレコードの項目なので、引き継ぎメモは増えない。1番目と3番目の比較質問も同じ経路で答える',
    steps: [
      say('池袋で10万まで。バストイレ別がいいです', ex({ ops: [area('池袋'), rentMax(100000), addTag('バストイレ別')] }), {
        state: 'presenting',
        cards: true,
        total: { min: 9, max: 9 },
        excludes: ['営業時間外'],
      }),
      say(
        '2番目の部屋は何階ですか？',
        ex({ intent: 'propertyQuestion', targetPositions: [2] }),
        { state: 'qa', cards: false, handoff: false },
        { answer: 'answered' },
      ),
      say(
        '1番目と3番目だと、どっちが広いですか？',
        ex({ intent: 'propertyQuestion', targetPositions: [1, 3] }),
        { state: 'qa', cards: false, handoff: false },
        { answer: 'answered', note: '比較質問。両方のレコードの面積を並べて答える' },
      ),
      card('detail', 3, { state: 'qa', cards: false, quickReplies: ['この物件の内見を希望'] }),
      tap('この物件の内見を希望', { state: 'booking', viewing: false, quickReplies: ['10月18日(日)'] }),
      tapIndex(0, { state: 'booking', viewing: false, quickReplies: ['この日時で送る'] }),
      tap('この日時で送る', {
        state: 'handed_off',
        viewing: true,
        includes: ['受け付けました', '担当者から確定のご連絡をします'],
        excludes: ['営業時間外'],
      }),
    ],
  },

  {
    id: 'sc-10',
    title: '提示物件への質問（レコードに無い）→ 担当者へ引き継ぎ',
    start: '2026-10-16T07:30:00+09:00',
    expectedReach: 'handoff',
    note: '金曜の早朝（開店前）。周辺のコンビニはレコードに無い項目なので、推測せず「担当者が確認します」で引き継ぎ、メモを残す。内見までは行かないが引き継ぎまでは到達する',
    steps: [
      say('目黒か祐天寺で9万まで', ex({ ops: [area('目黒', '祐天寺'), rentMax(90000)] }), {
        state: 'presenting',
        cards: true,
        total: { min: 4, max: 4 },
        includes: ['営業時間外'],
      }),
      say(
        '2番目の部屋って何階ですか？',
        ex({ intent: 'propertyQuestion', targetPositions: [2] }),
        { state: 'qa', cards: false, handoff: false },
        { answer: 'answered' },
      ),
      say(
        '1番目の近くにコンビニってありますか？',
        ex({ intent: 'propertyQuestion', targetPositions: [1] }),
        {
          state: 'qa',
          cards: false,
          handoff: true,
          viewing: false,
          includes: ['担当者が確認します', '10月16日(金)に担当者からご連絡します'],
        },
        { answer: 'handoff', note: 'レコードに無い項目（周辺施設）。回答生成が答えず、定型の引き継ぎ文とメモになる' },
      ),
    ],
  },

  {
    id: 'sc-11',
    title: '初期費用を聞かれて引き継ぎ → AI は止まらず探し直せる → 「担当者と話したい」で再び引き継ぎ',
    start: '2026-10-22T08:50:00+09:00',
    expectedReach: 'handoff',
    note: '木曜の開店前。禁止トピック（初期費用の確定額）は答えずに引き継ぐ。引き継ぎでも AI の応答は止めない（止まるのは担当者が手動返信したときだけ）',
    steps: [
      say('渋谷で9万まで', ex({ ops: [area('渋谷'), rentMax(90000)] }), {
        state: 'presenting',
        cards: true,
        total: { min: 7, max: 7 },
        includes: ['営業時間外'],
      }),
      say('初期費用って全部でいくらになりますか？', ex({ intent: 'handoff', forbiddenTopic: 'initialCostTotal' }), {
        state: 'presenting',
        cards: false,
        handoff: true,
        includes: ['初期費用の確定額については担当者が確認します', '10月22日(木)に担当者からご連絡します'],
      }),
      say(
        'じゃあ中目黒も見てみたいです',
        ex({ ops: [area('渋谷', '中目黒')] }),
        { state: 'presenting', cards: true, total: { min: 11, max: 11 }, handoff: false },
        { note: '引き継ぎのあとも条件の変更を受けて探し直す' },
      ),
      say('やっぱり担当の人と直接話したいです', ex({ intent: 'handoff' }), {
        state: 'presenting',
        cards: false,
        handoff: true,
        includes: ['このご質問は担当者が確認します'],
      }),
    ],
  },

  {
    id: 'sc-12',
    title: '条件の変更と「空いてますか」が同時 → 引き継ぎつつ探し直す → 自由文で内見の日時',
    start: '2026-10-18T11:30:00+09:00',
    expectedReach: 'viewing',
    note: '営業時間内（日曜の午前）。条件の変更を捨てず、空室は担当者へ回す（引き継ぎ文に続けて検索し直す）。内見も仮受付まで進むので到達は viewing',
    steps: [
      say('渋谷で9万まで', ex({ ops: [area('渋谷'), rentMax(90000)] }), {
        state: 'presenting',
        cards: true,
        total: { min: 7, max: 7 },
        excludes: ['営業時間外'],
      }),
      say(
        '予算を12万に上げます。あと1番目って空いてますか？',
        ex({ intent: 'conditions', ops: [rentMax(120000)], targetPositions: [1], forbiddenTopic: 'vacancy' }),
        {
          state: 'presenting',
          cards: true,
          total: { min: 11, max: 11 },
          handoff: true,
          includes: ['空室状況については担当者が確認します', '営業時間内に担当者からご連絡します'],
        },
        { note: '条件の変更（rentMax）と空室の質問が同時。intent は conditions でも handoff でもよい（eval/datasets/extraction.ts の ex-028）が、台本の正解は conditions' },
      ),
      say(
        '1番目、明日の15時と火曜の11時で見に行きたいです',
        ex({ intent: 'viewingRequest', targetPositions: [1], viewingTimes: ['2026-10-19T15:00', '2026-10-20T11:00'] }),
        { state: 'handed_off', viewing: true, includes: ['受け付けました', '担当者から確定のご連絡をします'], excludes: ['営業時間外'] },
      ),
    ],
  },

  {
    id: 'sc-13',
    title: '条件を聞かれたところで離れる（到達しない）',
    start: '2026-10-20T16:20:00+09:00',
    expectedReach: 'none',
    note: '営業時間内（火曜の夕方）。エリアだけ伝えて予算を聞かれ、答えずに離れる。内見の仮受付も引き継ぎも無いので到達しない',
    steps: [
      follow({ state: 'hearing', excludes: ['営業時間外'], quickReplies: ['渋谷'] }),
      say('渋谷あたりで探してます', ex({ ops: [area('渋谷')] }), {
        state: 'hearing',
        cards: false,
        includes: ['ご予算'],
        conditions: [{ ref: { kind: 'slot', key: 'area' } }],
        quickReplies: ['7万円まで', '9万円まで'],
      }),
      say('うーん、ちょっと考えます。ありがとうございました', ex({ intent: 'offTopic' }), {
        state: 'hearing',
        cards: false,
        handoff: false,
        viewing: false,
        includes: ['賃貸物件探しのお手伝い'],
      }),
    ],
  },

  {
    id: 'sc-14',
    title: '緩和の提案を断って離れる（到達しない）',
    start: '2026-10-17T19:40:00+09:00',
    expectedReach: 'none',
    note: '土曜の閉店後。2件だけの提案を見て「このままにする」を選び、お礼を言って離れる。断った条件は変えない',
    steps: [
      say('渋谷で8万まで', ex({ ops: [area('渋谷'), rentMax(80000)] }), {
        state: 'presenting',
        cards: true,
        total: { min: 2, max: 2 },
        includes: ['営業時間外', '隣の駅（恵比寿・原宿・代官山）も含めると2件増えます'],
        quickReplies: ['条件を変える', 'このままにする'],
      }),
      tap('このままにする', { state: 'presenting', cards: false, total: { min: 2, max: 2 }, includes: ['条件はそのままにします'] }),
      say('ありがとうございます。また連絡しますね', ex({ intent: 'offTopic' }), {
        state: 'presenting',
        cards: false,
        handoff: false,
        viewing: false,
      }),
    ],
  },

  {
    id: 'sc-15',
    title: '0件で緩められる条件を聞かれる → まだ0件 → 予算を上げ直して内見',
    start: '2026-10-19T22:45:00+09:00',
    expectedReach: 'viewing',
    note: '緩められる条件が無い0件でも行き止まりにしない（意思決定ログ8）: 「どの条件なら緩められそうですか？」とボタンで聞き、それでも0件なら条件の変え方の例を返す。全条件 AND でも 0 件で、利用者が離れる想定のベースラインはここで終わる',
    steps: [
      say('渋谷で5万まで。オートロックは必須です', ex({ ops: [area('渋谷'), rentMax(50000), addTag('オートロック', 'must')] }), {
        state: 'hearing',
        cards: false,
        total: { max: 0 },
        includes: ['どの条件なら緩められそうですか？'],
        quickReplies: ['オートロック', '予算5万円以内'],
      }),
      tap('オートロック', {
        state: 'hearing',
        cards: false,
        total: { max: 0 },
        includes: ['条件を変えて送ってください'],
        conditions: [{ ref: { kind: 'tag', tag: 'オートロック' }, priority: 'want' }],
      }),
      say('じゃあ予算は9万まで上げます', ex({ ops: [rentMax(90000)] }), {
        state: 'presenting',
        cards: true,
        total: { min: 7, max: 7 },
      }),
      say('2番目の内見をお願いします', ex({ intent: 'viewingRequest', targetPositions: [2] }), {
        state: 'booking',
        viewing: false,
        quickReplies: ['10月20日(火)'],
      }),
      tapIndex(0, { state: 'booking', viewing: false, quickReplies: ['この日時で送る'] }),
      tap('この日時で送る', { state: 'handed_off', viewing: true, includes: ['受け付けました', '10月20日(火)に担当者から確定のご連絡'] }),
    ],
  },
];
