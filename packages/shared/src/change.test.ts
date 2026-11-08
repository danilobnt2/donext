import { describe, expect, it } from 'vitest';
import { parseDeviceMeta } from './change';

describe('parseDeviceMeta', () => {
  it('defaults to an unidentified device with no device time', () => {
    expect(parseDeviceMeta({})).toEqual({
      ok: true,
      value: { actor: { kind: 'device', id: null }, deviceChangedAt: null },
    });
  });

  it('reads a device id and a zoned device time', () => {
    const meta = parseDeviceMeta({
      deviceId: '01JC0000000000000000000000',
      deviceChangedAt: '2026-11-04T10:00:00+01:00',
    });
    expect(meta).toEqual({
      ok: true,
      value: {
        actor: { kind: 'device', id: '01JC0000000000000000000000' },
        deviceChangedAt: Date.UTC(2026, 10, 4, 9),
      },
    });
  });

  it.each([{ deviceId: 'phone' }, { deviceChangedAt: '2026-11-04 10:00' }, { deviceChangedAt: 0 }])(
    'rejects %j',
    (input) => {
      expect(parseDeviceMeta(input)).toMatchObject({ ok: false, code: 'invalid_device' });
    },
  );
});
