import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  PageInputSchema,
  PageSchema,
  SortSpecSchema,
  FilterSchema,
  buildPage,
  nextOffset,
  decodeCursor,
  DEFAULT_PAGE_INPUT,
} from '../src/query.js';

const ItemSchema = z.object({ id: z.string(), name: z.string() });
const PageOfItems = PageSchema(ItemSchema);

describe('query — PageInputSchema', () => {
  it('parses minimal input with defaults', () => {
    const parsed = PageInputSchema.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(0);
    expect(parsed.sort).toEqual([]);
    expect(parsed.filter).toEqual([]);
  });
  it('rejects limit > 1000', () => {
    expect(() => PageInputSchema.parse({ limit: 1001 })).toThrow();
  });
  it('rejects negative offset', () => {
    expect(() => PageInputSchema.parse({ offset: -1 })).toThrow();
  });
  it('rejects more than 4 sort specs', () => {
    const sorts = Array.from({ length: 5 }, () => ({ field: 'a', dir: 'asc' }));
    expect(() => PageInputSchema.parse({ sort: sorts })).toThrow();
  });
  it('rejects more than 32 filter clauses', () => {
    const filter = Array.from({ length: 33 }, () => ({
      field: 'a',
      op: 'eq' as const,
    }));
    expect(() => PageInputSchema.parse({ filter })).toThrow();
  });
  it('accepts a full input', () => {
    const parsed = PageInputSchema.parse({
      limit: 25,
      offset: 50,
      sort: [{ field: 'name', dir: 'desc' }],
      filter: [{ field: 'status', op: 'eq', value: 'active' }],
      q: 'foo',
    });
    expect(parsed.limit).toBe(25);
    expect(parsed.q).toBe('foo');
  });
});

describe('query — SortSpecSchema', () => {
  it('defaults to asc', () => {
    const parsed = SortSpecSchema.parse({ field: 'name' });
    expect(parsed.dir).toBe('asc');
  });
  it('rejects unknown direction', () => {
    expect(() => SortSpecSchema.parse({ field: 'name', dir: 'sideways' })).toThrow();
  });
  it('rejects empty field', () => {
    expect(() => SortSpecSchema.parse({ field: '' })).toThrow();
  });
});

describe('query — FilterSchema', () => {
  it('accepts a single clause', () => {
    const parsed = FilterSchema.parse([{ field: 'a', op: 'eq', value: 1 }]);
    expect(parsed).toHaveLength(1);
  });
  it('rejects unknown op', () => {
    expect(() => FilterSchema.parse([{ field: 'a', op: 'regex' as 'eq' }])).toThrow();
  });
  it('accepts `isNull` and `isNotNull` without a value', () => {
    const parsed = FilterSchema.parse([{ field: 'a', op: 'isNull' }]);
    expect(parsed[0]?.value).toBeUndefined();
  });
});

describe('query — PageSchema', () => {
  it('validates a complete page', () => {
    const parsed = PageOfItems.parse({
      data: [{ id: '1', name: 'a' }],
      total: 1,
      limit: 50,
      offset: 0,
      nextCursor: null,
      timestamp: '2026-06-03T13:08:43-03:00',
    });
    expect(parsed.data).toHaveLength(1);
    expect(parsed.nextCursor).toBeNull();
  });
  it('rejects a non-array data', () => {
    expect(() =>
      PageOfItems.parse({
        data: 'not-an-array',
        total: 0,
        limit: 50,
        offset: 0,
        nextCursor: null,
        timestamp: '2026-06-03T13:08:43-03:00',
      }),
    ).toThrow();
  });
});

describe('query — buildPage / nextOffset', () => {
  it('nextOffset returns null when at the end', () => {
    expect(nextOffset({ offset: 50, limit: 50, total: 100 })).toBeNull();
    expect(nextOffset({ offset: 49, limit: 50, total: 100 })).toBe(99);
  });
  it('buildPage sets a cursor for the next page', () => {
    const page = buildPage(
      [{ id: '1' }],
      100,
      { limit: 50, offset: 0, sort: [], filter: [] },
      '2026-06-03T13:08:43-03:00',
    );
    expect(page.nextCursor).not.toBeNull();
    const decoded = decodeCursor(page.nextCursor as string);
    expect(decoded?.offset).toBe(50);
  });
  it('buildPage returns null cursor when at the end', () => {
    const page = buildPage(
      [],
      50,
      { limit: 50, offset: 0, sort: [], filter: [] },
      '2026-06-03T13:08:43-03:00',
    );
    expect(page.nextCursor).toBeNull();
  });
  it('decodeCursor returns null on garbage', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });
  it('round-trip: cursor -> decode -> next offset', () => {
    const page = buildPage(
      [],
      200,
      { limit: 50, offset: 100, sort: [], filter: [] },
      '2026-06-03T13:08:43-03:00',
    );
    const decoded = decodeCursor(page.nextCursor as string);
    expect(decoded?.offset).toBe(150);
  });
});

describe('query — DEFAULT_PAGE_INPUT', () => {
  it('matches what PageInputSchema produces from {}', () => {
    expect(DEFAULT_PAGE_INPUT).toEqual({
      limit: 50,
      offset: 0,
      sort: [],
      filter: [],
    });
  });
});
