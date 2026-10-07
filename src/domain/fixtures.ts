/**
 * テスト用の物件とスロットの組み立て（本番コードからは使わない）。
 */
import type { Property, Slots } from './types';

let seq = 0;

export function makeProperty(overrides: Partial<Property> = {}): Property {
  seq += 1;
  return {
    id: `T${String(seq).padStart(4, '0')}`,
    name: `テスト荘${seq}`,
    address: '渋谷区かえで町1-1',
    ward: '渋谷区',
    access: [{ station: '渋谷', walkMin: 8 }],
    rent: 80000,
    managementFee: 5000,
    depositMonths: 1,
    keyMoneyMonths: 1,
    layout: '1K',
    areaSqm: 22,
    floor: 3,
    builtYear: 2015,
    tags: ['バストイレ別'],
    note: '',
    availableFrom: null,
    status: 'public',
    ...overrides,
  };
}

/** 渋谷・予算9万（must）だけのスロット */
export function baseSlots(overrides: Partial<Slots> = {}): Slots {
  return {
    area: { value: { stations: ['渋谷'], wards: [] }, priority: 'must' },
    rentMax: { value: 90000, priority: 'must' },
    tags: [],
    ...overrides,
  };
}
