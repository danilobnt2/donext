import { describe, expect, it } from 'vitest';
import { VERSION_LIMIT, oldestKeptVersion } from './versions';

describe('oldestKeptVersion', () => {
  it('keeps the newest VERSION_LIMIT versions', () => {
    expect(oldestKeptVersion(1)).toBe(1);
    expect(oldestKeptVersion(VERSION_LIMIT)).toBe(1);
    expect(oldestKeptVersion(VERSION_LIMIT + 1)).toBe(2);
  });
});
