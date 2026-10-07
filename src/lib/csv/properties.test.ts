import { describe, expect, it } from 'vitest';
import type { Property } from '../../domain/types';
import {
  PROPERTY_CSV_COLUMNS,
  parseCsvRecords,
  parsePropertiesCsv,
  serializePropertiesCsv,
  type PropertyRow,
} from './properties';

const HEADER = PROPERTY_CSV_COLUMNS.join(',');

function row(overrides: Partial<PropertyRow> = {}): PropertyRow {
  return {
    id: 'P0001',
    name: 'コーポかえで',
    address: '渋谷区かえで町2-14',
    ward: '渋谷区',
    access: [
      { station: '渋谷', walkMin: 7 },
      { station: '代官山', walkMin: 12 },
    ],
    rent: 85000,
    managementFee: 5000,
    depositMonths: 1,
    keyMoneyMonths: 0.5,
    layout: '1K',
    areaSqm: 22.5,
    floor: 3,
    builtYear: 2008,
    note: 'バス・トイレ別、オートロック付き。',
    availableFrom: '2026-11-15',
    status: 'public',
    ...overrides,
  };
}

/** 正常な 1 行（見出しの列順どおり） */
const VALID_LINE = 'P0001,コーポかえで,渋谷区かえで町2-14,渋谷区,渋谷:7|代官山:12,85000,5000,1,0.5,1K,22.5,3,2008,バス・トイレ別、オートロック付き。,2026-11-15,public';

describe('parseCsvRecords（RFC 4180）', () => {
  it('単純な行を読む。CRLF・LF・CR のどれでも同じ', () => {
    const expected = [
      { line: 1, fields: ['a', 'b', 'c'] },
      { line: 2, fields: ['1', '2', '3'] },
    ];
    expect(parseCsvRecords('a,b,c\n1,2,3\n')).toEqual(expected);
    expect(parseCsvRecords('a,b,c\r\n1,2,3\r\n')).toEqual(expected);
    expect(parseCsvRecords('a,b,c\r1,2,3\r')).toEqual(expected);
    expect(parseCsvRecords('a,b,c\n1,2,3')).toEqual(expected);
  });

  it('先頭の BOM を無視する', () => {
    expect(parseCsvRecords('﻿a,b\n1,2\n')).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['1', '2'] },
    ]);
  });

  it('引用符の中のカンマ・改行・二重引用符を読む', () => {
    const text = 'a,b\n"x,y","line1\nline2","say ""hi"""\n';
    expect(parseCsvRecords(text)).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['x,y', 'line1\nline2', 'say "hi"'] },
    ]);
  });

  it('引用符の中の CRLF は LF にそろえる', () => {
    expect(parseCsvRecords('a\r\n"x\r\ny"\r\n')[1].fields).toEqual(['x\ny']);
  });

  it('空の欄・空の引用欄・末尾のカンマを欄として数える', () => {
    expect(parseCsvRecords('a,,c,\n"",x,"",\n').map((r) => r.fields)).toEqual([
      ['a', '', 'c', ''],
      ['', 'x', '', ''],
    ]);
  });

  it('空行は読み飛ばし、欄内の改行ぶんだけ後続の行番号が進む', () => {
    const records = parseCsvRecords('h\n\n"a\nb\nc"\n\nz\n');
    expect(records.map((r) => [r.line, r.fields])).toEqual([
      [1, ['h']],
      [3, ['a\nb\nc']],
      [7, ['z']],
    ]);
  });

  it('引用符で始まらない欄の途中の二重引用符はそのまま', () => {
    expect(parseCsvRecords('5"x,y\n')[0].fields).toEqual(['5"x', 'y']);
  });

  it('閉じていない引用符・閉じ引用符の後の余分な文字はレコードのエラーにする', () => {
    const unterminated = parseCsvRecords('a,b\n"abc,def\n');
    expect(unterminated[1].line).toBe(2);
    expect(unterminated[1].error).toMatch(/閉じられていません/);

    const junk = parseCsvRecords('a,b\n"abc"def,1\nx,y\n');
    expect(junk[1].error).toMatch(/余分な文字/);
    expect(junk[2]).toEqual({ line: 3, fields: ['x', 'y'] });
  });

  it('閉じ引用符の後の空白は許す', () => {
    expect(parseCsvRecords('"a" ,"b"\t\n')[0]).toEqual({ line: 1, fields: ['a', 'b'] });
  });

  it('空の入力はレコード 0 件', () => {
    expect(parseCsvRecords('')).toEqual([]);
    expect(parseCsvRecords('\n\n')).toEqual([]);
  });
});

describe('parsePropertiesCsv', () => {
  it('正常な行を物件に変換する（tags は持たない）', () => {
    const { rows, errors } = parsePropertiesCsv(`${HEADER}\n${VALID_LINE}\n`);
    expect(errors).toEqual([]);
    expect(rows).toEqual([row()]);
    expect(rows[0]).not.toHaveProperty('tags');
  });

  it('見出しは並びが違ってもよく、BOM・CRLF 付きでも読める', () => {
    const columns = [...PROPERTY_CSV_COLUMNS].reverse();
    const values = VALID_LINE.split(',');
    // note に読点はあるが ASCII のカンマは無いので単純に分けられる
    const byColumn = Object.fromEntries(PROPERTY_CSV_COLUMNS.map((c, i) => [c, values[i]]));
    const text = `﻿${columns.join(',')}\r\n${columns.map((c) => byColumn[c]).join(',')}\r\n`;
    const { rows, errors } = parsePropertiesCsv(text);
    expect(errors).toEqual([]);
    expect(rows).toEqual([row()]);
  });

  it('ward・note・available_from・status は省略できる（ward は先頭の駅の所在地、status は public）', () => {
    const text = [
      'id,name,address,access,rent,management_fee,deposit_months,key_money_months,layout,area_sqm,floor,built_year',
      'P0002,ハイツみどり,目黒区みどり台1-1,中目黒:5,90000,0,0,0,1R,18,2,2000',
    ].join('\n');
    const { rows, errors } = parsePropertiesCsv(text);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      row({
        id: 'P0002',
        name: 'ハイツみどり',
        address: '目黒区みどり台1-1',
        ward: '目黒区',
        access: [{ station: '中目黒', walkMin: 5 }],
        rent: 90000,
        managementFee: 0,
        depositMonths: 0,
        keyMoneyMonths: 0,
        layout: '1R',
        areaSqm: 18,
        floor: 2,
        builtYear: 2000,
        note: '',
        availableFrom: null,
        status: 'public',
      }),
    ]);
  });

  it('欄が空の ward・available_from・status は既定値になる。status は日本語も受ける', () => {
    const line = (id: string, status: string) =>
      `${id},a,b,,渋谷:3,70000,0,1,1,1K,20,1,2000,,,${status}`;
    const { rows, errors } = parsePropertiesCsv([HEADER, line('P1', ''), line('P2', '公開'), line('P3', '非公開'), line('P4', 'private')].join('\n'));
    expect(errors).toEqual([]);
    expect(rows.map((r) => [r.id, r.ward, r.availableFrom, r.status])).toEqual([
      ['P1', '渋谷区', null, 'public'],
      ['P2', '渋谷区', null, 'public'],
      ['P3', '渋谷区', null, 'private'],
      ['P4', '渋谷区', null, 'private'],
    ]);
  });

  it('余分な列（tags など）は無視する', () => {
    const { rows, errors } = parsePropertiesCsv(`${HEADER},tags\n${VALID_LINE},ペット可\n`);
    expect(errors).toEqual([]);
    expect(rows).toEqual([row()]);
  });

  it('必須列が見出しに無いと、列ごとに 1 行目のエラーにして行は読まない', () => {
    const header = HEADER.replace(',rent', '').replace(',layout', '');
    const { rows, errors } = parsePropertiesCsv(`${header}\n${VALID_LINE}\n`);
    expect(rows).toEqual([]);
    expect(errors).toEqual([
      { line: 1, message: '必須列 rent が見出しにありません' },
      { line: 1, message: '必須列 layout が見出しにありません' },
    ]);
  });

  it('見出しの列が重複していたらエラー', () => {
    const { rows, errors } = parsePropertiesCsv(`${HEADER},rent\n${VALID_LINE},1\n`);
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: 1 });
    expect(errors[0].message).toMatch(/rent が重複/);
  });

  it('空のファイルはエラー、見出しだけなら 0 件でエラーなし', () => {
    expect(parsePropertiesCsv('').errors).toEqual([{ line: 1, message: '見出し行がありません（空のファイルです）' }]);
    expect(parsePropertiesCsv(`${HEADER}\n`)).toEqual({ rows: [], errors: [] });
  });

  describe('行ごとの検証', () => {
    /** VALID_LINE の指定した列だけ差し替えた行 */
    function lineWith(column: (typeof PROPERTY_CSV_COLUMNS)[number], value: string): string {
      const values = VALID_LINE.split(',');
      values[PROPERTY_CSV_COLUMNS.indexOf(column)] = value;
      return values.join(',');
    }
    const parseOne = (line: string) => parsePropertiesCsv(`${HEADER}\n${line}\n`);

    it('不正な layout', () => {
      const { rows, errors } = parseOne(lineWith('layout', '3LDK'));
      expect(rows).toEqual([]);
      expect(errors).toEqual([{ line: 2, message: expect.stringContaining('layout') }]);
      expect(errors[0].message).toContain('3LDK');
    });

    it('駅マスタに無い駅・「駅」付きの駅名', () => {
      expect(parseOne(lineWith('access', 'ほげ:5')).errors[0].message).toMatch(/駅マスタに無い駅です 「ほげ」/);
      expect(parseOne(lineWith('access', '渋谷駅:5')).errors[0].message).toMatch(/駅マスタに無い駅です 「渋谷駅」/);
    });

    it('access の形式違反（徒歩分なし・非数・重複・4 件・空）', () => {
      expect(parseOne(lineWith('access', '渋谷')).errors[0].message).toMatch(/駅名:徒歩分/);
      expect(parseOne(lineWith('access', '渋谷:たくさん')).errors[0].message).toMatch(/駅名:徒歩分/);
      expect(parseOne(lineWith('access', '渋谷:5|渋谷:9')).errors[0].message).toMatch(/重複/);
      expect(parseOne(lineWith('access', '渋谷:5|代官山:6|中目黒:7|祐天寺:8')).errors[0].message).toMatch(/3 件まで/);
      expect(parseOne(lineWith('access', '')).errors[0].message).toMatch(/access/);
    });

    it('access は全角コロンと空白を許す', () => {
      const { rows, errors } = parseOne(lineWith('access', '渋谷： 7 | 代官山 :12'));
      expect(errors).toEqual([]);
      expect(rows[0].access).toEqual([
        { station: '渋谷', walkMin: 7 },
        { station: '代官山', walkMin: 12 },
      ]);
    });

    it('数値でない値（rent・management_fee・area_sqm・floor・built_year・敷礼）', () => {
      for (const [column, value] of [
        ['rent', '八万円'],
        ['rent', '"85,000"'],
        ['rent', '0'],
        ['management_fee', '-1'],
        ['management_fee', '5.5'],
        ['area_sqm', 'abc'],
        ['area_sqm', '0'],
        ['floor', 'とても高い'],
        ['floor', '0'],
        ['built_year', '平成20年'],
        ['built_year', '1800'],
        ['deposit_months', '一ヶ月'],
        ['key_money_months', '-0.5'],
      ] as const) {
        const { rows, errors } = parseOne(lineWith(column, value));
        expect(rows, `${column}=${value}`).toEqual([]);
        expect(errors, `${column}=${value}`).toHaveLength(1);
        expect(errors[0].line).toBe(2);
        expect(errors[0].message.startsWith(`${column}:`), errors[0].message).toBe(true);
      }
    });

    it('必須の文字列欄が空', () => {
      for (const column of ['id', 'name', 'address'] as const) {
        const { errors } = parseOne(lineWith(column, ''));
        expect(errors).toEqual([{ line: 2, message: `${column}: 必須です` }]);
      }
    });

    it('available_from の形式違反と存在しない日付', () => {
      expect(parseOne(lineWith('available_from', '2026/11/15')).errors[0].message).toMatch(/YYYY-MM-DD/);
      expect(parseOne(lineWith('available_from', '2026-02-30')).errors[0].message).toMatch(/存在しない日付/);
      expect(parseOne(lineWith('available_from', '2026-13-01')).errors[0].message).toMatch(/存在しない日付/);
      expect(parseOne(lineWith('available_from', '2028-02-29')).errors).toEqual([]);
    });

    it('status の不正値', () => {
      expect(parseOne(lineWith('status', '成約済み')).errors[0].message).toMatch(/status/);
    });

    it('1 行に複数の問題があれば、すべて同じ行番号で返す', () => {
      const values = VALID_LINE.split(',');
      values[PROPERTY_CSV_COLUMNS.indexOf('layout')] = 'XX';
      values[PROPERTY_CSV_COLUMNS.indexOf('rent')] = 'abc';
      values[PROPERTY_CSV_COLUMNS.indexOf('access')] = 'ほげ:3';
      const { errors } = parseOne(values.join(','));
      expect(errors.map((e) => e.line)).toEqual([2, 2, 2]);
      expect(errors.map((e) => e.message.split(':')[0]).sort()).toEqual(['access', 'layout', 'rent']);
    });

    it('列数が見出しと合わない行', () => {
      const { rows, errors } = parseOne(VALID_LINE + ',余分');
      expect(rows).toEqual([]);
      expect(errors).toEqual([{ line: 2, message: expect.stringContaining('列数') }]);
      expect(parseOne('P1,a,b').errors[0].message).toContain('3 列');
    });

    it('id の重複は 2 行目以降をエラーにする', () => {
      const text = [HEADER, VALID_LINE, lineWith('name', '別の名前'), lineWith('id', 'P0002')].join('\n');
      const { rows, errors } = parsePropertiesCsv(text);
      expect(rows.map((r) => r.id)).toEqual(['P0001', 'P0002']);
      expect(errors).toEqual([{ line: 3, message: 'id: P0001 が重複しています（2 行目と同じ）' }]);
    });

    it('不正な行があっても、ほかの正常な行は読める。行番号は物理行（欄内の改行ぶんずれる）', () => {
      const multiLine = row({ id: 'P0002', note: '1行目\n2行目\n3行目' });
      const good = serializePropertiesCsv([multiLine]).split('\n').slice(1).join('\n'); // 見出しを除く（4 物理行）
      const bad = lineWith('layout', 'ZZ');
      const text = [HEADER, VALID_LINE, good.trimEnd(), bad, lineWith('id', 'P0004')].join('\n');
      // 1: 見出し / 2: P0001 / 3-5: P0002（欄内に改行 2 つ） / 6: 不正な行 / 7: P0004
      const { rows, errors } = parsePropertiesCsv(text);
      expect(rows.map((r) => r.id)).toEqual(['P0001', 'P0002', 'P0004']);
      expect(rows[1].note).toBe('1行目\n2行目\n3行目');
      expect(errors).toEqual([{ line: 6, message: expect.stringContaining('layout') }]);
    });

    it('引用符のエラーは行番号つきで返し、読めた行は残す', () => {
      const text = [HEADER, VALID_LINE, `P0002,"閉じない,x`].join('\n');
      const { rows, errors } = parsePropertiesCsv(text);
      expect(rows.map((r) => r.id)).toEqual(['P0001']);
      expect(errors).toEqual([{ line: 3, message: '引用符が閉じられていません' }]);
    });
  });
});

describe('serializePropertiesCsv', () => {
  it('見出しと 1 行を書く。LF・末尾改行・BOM なし・引用符は必要なときだけ', () => {
    const text = serializePropertiesCsv([row()]);
    expect(text).toBe(`${HEADER}\n${VALID_LINE}\n`);
    expect(text.includes('\r')).toBe(false);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text.includes('"')).toBe(false);
  });

  it('0 件なら見出しだけ', () => {
    expect(serializePropertiesCsv([])).toBe(`${HEADER}\n`);
  });

  it('カンマ・引用符・改行・前後の空白を含む欄は引用符で囲む', () => {
    const text = serializePropertiesCsv([
      row({ name: 'コーポ,かえで', note: '「静か」と"言う"\n2行目', address: ' 先頭に空白' }),
    ]);
    expect(text).toContain('"コーポ,かえで"');
    expect(text).toContain('"「静か」と""言う""\n2行目"');
    expect(text).toContain('" 先頭に空白"');
  });

  it('available_from が null なら空欄、access は 駅:分|駅:分', () => {
    const line = serializePropertiesCsv([row({ availableFrom: null, access: [{ station: '三鷹', walkMin: 1 }] })]).split('\n')[1];
    expect(line).toContain(',三鷹:1,');
    expect(line.split(',')[14]).toBe('');
  });

  it('パース → シリアライズ → パースで一致する', () => {
    const rows = [
      row(),
      row({ id: 'P0002', note: '', availableFrom: null, status: 'private', access: [{ station: '日吉', walkMin: 0 }], ward: '横浜市港北区' }),
      row({ id: 'P0003', note: 'ペット相談可（小型犬1匹まで）, BT別\n"オートロック"\n 前後に空白 ', layout: '2LDK', areaSqm: 61.3 }),
      row({ id: 'P0004', name: '名前,に"引用符"', depositMonths: 0, keyMoneyMonths: 2, floor: 12, builtYear: 1985 }),
    ];
    const text = serializePropertiesCsv(rows);
    const first = parsePropertiesCsv(text);
    expect(first.errors).toEqual([]);
    expect(first.rows).toEqual(rows);

    const again = parsePropertiesCsv(serializePropertiesCsv(first.rows));
    expect(again.errors).toEqual([]);
    expect(again.rows).toEqual(first.rows);
    expect(serializePropertiesCsv(again.rows)).toBe(text);
  });

  it('tags を持つ Property をそのまま渡しても tags 列は出さない', () => {
    const withTags: Property = { ...row(), tags: ['ペット可'] };
    const text = serializePropertiesCsv([withTags]);
    expect(text.split('\n')[0]).toBe(HEADER);
    expect(text).not.toContain('ペット可');
  });
});
