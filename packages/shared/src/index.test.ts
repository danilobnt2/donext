import { describe, expect, it } from 'vitest';
import { TITLE_MAX_LENGTH, checkTitle } from './index';

describe('checkTitle', () => {
  it('trims and accepts a normal title', () => {
    expect(checkTitle('  Cut the lawn ')).toEqual({ ok: true, title: 'Cut the lawn' });
  });

  it('rejects empty, blank and non-string titles', () => {
    expect(checkTitle('').ok).toBe(false);
    expect(checkTitle('   ').ok).toBe(false);
    expect(checkTitle(42).ok).toBe(false);
    expect(checkTitle(undefined).ok).toBe(false);
  });

  it('counts code points, not UTF-16 units', () => {
    expect(checkTitle('🙂'.repeat(TITLE_MAX_LENGTH)).ok).toBe(true);
    expect(checkTitle('a'.repeat(TITLE_MAX_LENGTH + 1)).ok).toBe(false);
  });
});
