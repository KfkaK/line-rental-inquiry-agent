/**
 * 物件 CSV の列定義・パーサ・シリアライザ（DESIGN.md 5章・8章）。
 *
 * - 列は DB 列に合わせた英語 snake_case。`tags` 列は持たない（取込時に備考から抽出する。敷金なし・礼金なしは数値列から決める）
 * - `access` は `渋谷:7|代官山:12` の形式（先頭が最寄り）
 * - パーサは RFC 4180 準拠（ダブルクォート・欄内のカンマと改行・CRLF/LF・先頭 BOM）。
 *   欄内の改行は LF にそろえる。空行は読み飛ばす
 * - 行ごとに検証し、不正な行は `errors` に行番号つきで積んで `rows` に含めない
 *   （行番号は物理行。見出しが 1 行目。欄内に改行があると 1 レコードが複数行にまたがる）
 */
import { LAYOUTS, type Layout, type Property } from '../../domain/types';
import { findStation } from '../../domain/stations';

export type PropertyRow = Omit<Property, 'tags'>;

export interface CsvRowError {
  /** 物理行番号（1 始まり。見出しが 1 行目） */
  line: number;
  message: string;
}

export interface ParsePropertiesResult {
  rows: PropertyRow[];
  errors: CsvRowError[];
}

export const PROPERTY_CSV_COLUMNS = [
  'id',
  'name',
  'address',
  'ward',
  'access',
  'rent',
  'management_fee',
  'deposit_months',
  'key_money_months',
  'layout',
  'area_sqm',
  'floor',
  'built_year',
  'note',
  'available_from',
  'status',
] as const;
export type PropertyCsvColumn = (typeof PROPERTY_CSV_COLUMNS)[number];

/** 省略できる列（見出しに無い・空欄でもよい）。ward は先頭の駅の所在地、status は public になる */
const OPTIONAL_COLUMNS: readonly PropertyCsvColumn[] = ['ward', 'note', 'available_from', 'status'];

export const ACCESS_MAX = 3;
const WALK_MAX_MIN = 120;

// ---------- RFC 4180 トークナイザ ----------

export interface CsvRecord {
  /** レコードが始まる物理行（1 始まり） */
  line: number;
  fields: string[];
  /** 引用符まわりの構文エラー（あれば） */
  error?: string;
}

/** 文字列全体を CSV として読む。空行は返さない。先頭の BOM は無視する */
export function parseCsvRecords(input: string): CsvRecord[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: CsvRecord[] = [];

  let fields: string[] = [];
  let field = '';
  let quoted = false; // 現在の欄が引用符で始まったか
  let inQuotes = false;
  let afterQuote = false; // 閉じ引用符の直後
  let line = 1;
  let recordLine = 1;
  let error: string | undefined;

  const endField = () => {
    fields.push(field);
    field = '';
    quoted = false;
    afterQuote = false;
  };
  const endRecord = () => {
    const blank = fields.length === 0 && field === '' && !quoted;
    if (!blank) {
      endField();
      records.push(error ? { line: recordLine, fields, error } : { line: recordLine, fields });
    }
    fields = [];
    field = '';
    quoted = false;
    afterQuote = false;
    error = undefined;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else if (c === '\r') {
        if (text[i + 1] === '\n') i++;
        field += '\n';
        line++;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"') {
      if (field === '' && !quoted) {
        inQuotes = true;
        quoted = true;
      } else if (afterQuote) {
        // "" の連続は上で処理済み。閉じ引用符の後の " は構文エラー
        error ??= '閉じ引用符の後に余分な文字があります';
        field += c;
      } else {
        field += c; // 引用符で始まらない欄の途中の " はそのまま
      }
    } else if (c === ',') {
      endField();
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
    } else if (afterQuote) {
      if (c !== ' ' && c !== '\t') {
        error ??= '閉じ引用符の後に余分な文字があります';
        field += c;
      }
    } else {
      field += c;
    }
  }
  if (inQuotes) {
    error ??= '引用符が閉じられていません';
    endField();
    records.push({ line: recordLine, fields, error });
  } else if (fields.length > 0 || field !== '' || quoted) {
    endRecord();
  }
  return records;
}

// ---------- 列ごとの検証 ----------

const INT_RE = /^\d+$/;
const DECIMAL_RE = /^\d+(\.\d+)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };
const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (message: string): Parsed<never> => ({ ok: false, message });

function show(raw: string): string {
  return raw === '' ? '（空）' : `「${raw}」`;
}

function parseInteger(column: string, raw: string, min: number, max?: number): Parsed<number> {
  if (!INT_RE.test(raw)) return fail(`${column}: 整数ではありません ${show(raw)}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || (max !== undefined && n > max)) {
    const range = max === undefined ? `${min} 以上` : `${min}〜${max}`;
    return fail(`${column}: ${range} の整数が必要です ${show(raw)}`);
  }
  return ok(n);
}

function parseDecimal(column: string, raw: string, opts: { positive: boolean }): Parsed<number> {
  if (!DECIMAL_RE.test(raw)) return fail(`${column}: 数値ではありません ${show(raw)}`);
  const n = Number(raw);
  if (!Number.isFinite(n) || (opts.positive && n <= 0)) return fail(`${column}: 0 より大きい数値が必要です ${show(raw)}`);
  return ok(n);
}

function parseAccess(raw: string): Parsed<Property['access']> {
  if (raw === '') return fail('access: 空です（例: 渋谷:7|代官山:12）');
  const parts = raw.split('|');
  if (parts.length > ACCESS_MAX) return fail(`access: ${ACCESS_MAX} 件までです ${show(raw)}`);
  const access: Property['access'] = [];
  for (const part of parts) {
    const m = /^\s*([^:：]+?)\s*[:：]\s*(\d+)\s*$/.exec(part);
    if (!m) return fail(`access: 「駅名:徒歩分」の形式ではありません ${show(part)}`);
    const station = m[1];
    if (!findStation(station)) return fail(`access: 駅マスタに無い駅です 「${station}」（「駅」は付けません）`);
    if (access.some((a) => a.station === station)) return fail(`access: 同じ駅が重複しています 「${station}」`);
    const walkMin = Number(m[2]);
    if (!Number.isSafeInteger(walkMin) || walkMin > WALK_MAX_MIN) {
      return fail(`access: 徒歩分が範囲外です（0〜${WALK_MAX_MIN}）「${part.trim()}」`);
    }
    access.push({ station, walkMin });
  }
  return ok(access);
}

function parseLayout(raw: string): Parsed<Layout> {
  const layout = LAYOUTS.find((l) => l === raw);
  return layout ? ok(layout) : fail(`layout: 間取りが不正です ${show(raw)}（${LAYOUTS.join('/')}）`);
}

function parseDate(raw: string): Parsed<string | null> {
  if (raw === '') return ok(null);
  const m = DATE_RE.exec(raw);
  if (!m) return fail(`available_from: YYYY-MM-DD の形式ではありません ${show(raw)}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return fail(`available_from: 存在しない日付です ${show(raw)}`);
  }
  return ok(raw);
}

const STATUS_ALIASES: Record<string, Property['status']> = {
  public: 'public',
  private: 'private',
  公開: 'public',
  非公開: 'private',
};

function parseStatus(raw: string): Parsed<Property['status']> {
  if (raw === '') return ok('public');
  const status = STATUS_ALIASES[raw];
  return status ? ok(status) : fail(`status: public / private のどちらかです ${show(raw)}`);
}

function parseRow(cells: Record<PropertyCsvColumn, string>): { row?: PropertyRow; messages: string[] } {
  const messages: string[] = [];
  const take = <T>(p: Parsed<T>): T | undefined => {
    if (p.ok) return p.value;
    messages.push(p.message);
    return undefined;
  };
  const required = (column: PropertyCsvColumn): string | undefined => {
    const v = cells[column].trim();
    if (v === '') {
      messages.push(`${column}: 必須です`);
      return undefined;
    }
    return v;
  };

  const id = required('id');
  const name = required('name');
  const address = required('address');
  const access = take(parseAccess(cells.access.trim()));
  const rent = take(parseInteger('rent', cells.rent.trim(), 1));
  const managementFee = take(parseInteger('management_fee', cells.management_fee.trim(), 0));
  const depositMonths = take(parseDecimal('deposit_months', cells.deposit_months.trim(), { positive: false }));
  const keyMoneyMonths = take(parseDecimal('key_money_months', cells.key_money_months.trim(), { positive: false }));
  const layout = take(parseLayout(cells.layout.trim()));
  const areaSqm = take(parseDecimal('area_sqm', cells.area_sqm.trim(), { positive: true }));
  const floor = take(parseInteger('floor', cells.floor.trim(), 1, 200));
  const builtYear = take(parseInteger('built_year', cells.built_year.trim(), 1900, 2100));
  const availableFrom = take(parseDate(cells.available_from.trim()));
  const status = take(parseStatus(cells.status.trim()));
  const ward = cells.ward.trim() || (access ? findStation(access[0].station)?.ward : undefined);

  if (messages.length > 0) return { messages };
  return {
    messages,
    row: {
      id: id!,
      name: name!,
      address: address!,
      ward: ward!,
      access: access!,
      rent: rent!,
      managementFee: managementFee!,
      depositMonths: depositMonths!,
      keyMoneyMonths: keyMoneyMonths!,
      layout: layout!,
      areaSqm: areaSqm!,
      floor: floor!,
      builtYear: builtYear!,
      note: cells.note,
      availableFrom: availableFrom ?? null,
      status: status!,
    },
  };
}

// ---------- パーサ ----------

/** 物件 CSV を読む。不正な行は `errors` に積み、`rows` には含めない */
export function parsePropertiesCsv(text: string): ParsePropertiesResult {
  const rows: PropertyRow[] = [];
  const errors: CsvRowError[] = [];
  const records = parseCsvRecords(text);
  if (records.length === 0) {
    errors.push({ line: 1, message: '見出し行がありません（空のファイルです）' });
    return { rows, errors };
  }

  const [header, ...body] = records;
  if (header.error) errors.push({ line: header.line, message: `見出し行: ${header.error}` });
  const names = header.fields.map((f) => f.trim());
  const index = new Map<string, number>();
  names.forEach((n, i) => {
    if (index.has(n)) errors.push({ line: header.line, message: `見出し行: 列 ${n} が重複しています` });
    else index.set(n, i);
  });
  for (const column of PROPERTY_CSV_COLUMNS) {
    if (!index.has(column) && !OPTIONAL_COLUMNS.includes(column)) {
      errors.push({ line: header.line, message: `必須列 ${column} が見出しにありません` });
    }
  }
  if (errors.length > 0) return { rows, errors };

  const firstLineOfId = new Map<string, number>();
  for (const record of body) {
    if (record.error) {
      errors.push({ line: record.line, message: record.error });
      continue;
    }
    if (record.fields.length !== names.length) {
      errors.push({
        line: record.line,
        message: `列数が見出しと一致しません（見出し ${names.length} 列・この行 ${record.fields.length} 列）`,
      });
      continue;
    }
    const cells = {} as Record<PropertyCsvColumn, string>;
    for (const column of PROPERTY_CSV_COLUMNS) {
      const i = index.get(column);
      cells[column] = i === undefined ? '' : record.fields[i];
    }
    const { row, messages } = parseRow(cells);
    if (row) {
      const seen = firstLineOfId.get(row.id);
      if (seen !== undefined) {
        errors.push({ line: record.line, message: `id: ${row.id} が重複しています（${seen} 行目と同じ）` });
        continue;
      }
      firstLineOfId.set(row.id, record.line);
      rows.push(row);
    } else {
      for (const message of messages) errors.push({ line: record.line, message });
    }
  }
  return { rows, errors };
}

// ---------- シリアライザ ----------

function escapeField(value: string): string {
  return /[",\r\n]|^[ \t]|[ \t]$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function formatAccess(access: readonly { station: string; walkMin: number }[]): string {
  return access.map((a) => `${a.station}:${a.walkMin}`).join('|');
}

/** 物件を CSV に書き出す（見出し付き・LF・末尾改行あり・BOM なし）。`parsePropertiesCsv` で同じ内容に戻る */
export function serializePropertiesCsv(rows: readonly PropertyRow[]): string {
  const lines: string[] = [PROPERTY_CSV_COLUMNS.join(',')];
  for (const r of rows) {
    const fields: Record<PropertyCsvColumn, string> = {
      id: r.id,
      name: r.name,
      address: r.address,
      ward: r.ward,
      access: formatAccess(r.access),
      rent: String(r.rent),
      management_fee: String(r.managementFee),
      deposit_months: String(r.depositMonths),
      key_money_months: String(r.keyMoneyMonths),
      layout: r.layout,
      area_sqm: String(r.areaSqm),
      floor: String(r.floor),
      built_year: String(r.builtYear),
      note: r.note,
      available_from: r.availableFrom ?? '',
      status: r.status,
    };
    lines.push(PROPERTY_CSV_COLUMNS.map((c) => escapeField(fields[c])).join(','));
  }
  return lines.join('\n') + '\n';
}
