/**
 * What every change has in common, whatever kind of item it touches: who made it, the
 * device's metadata, and how a broken rule is reported.
 */

/** Who or what made a change. Connectors arrive with AI connectors. */
export type Actor =
  | { kind: 'device'; id: string | null }
  | { kind: 'system'; id: null }
  | { kind: 'connector'; id: string };

/** Rule violations any kind of item can report. Each kind adds its own codes. */
export type RuleViolationCode = 'invalid_change' | 'invalid_device';

/** A parsed value, or the rule it broke. `Code` is the codes the parser may report. */
export type Checked<T, Code extends string = RuleViolationCode> =
  { ok: true; value: T } | { ok: false; code: Code; message: string };

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Reads the optional device id and device time of a change made on an app device. A
 * device time older or newer than the server's is accepted: offline edits arrive late.
 */
export function parseDeviceMeta(
  input: unknown,
): Checked<{ actor: Actor & { kind: 'device' }; deviceChangedAt: number | null }> {
  const body = isObject(input) ? input : {};
  let id: string | null = null;
  if ('deviceId' in body) {
    if (typeof body.deviceId !== 'string' || !ULID.test(body.deviceId)) {
      return violation('invalid_device', 'deviceId must be a ULID.');
    }
    id = body.deviceId;
  }
  let deviceChangedAt: number | null = null;
  if ('deviceChangedAt' in body) {
    const time = typeof body.deviceChangedAt === 'string' ? Date.parse(body.deviceChangedAt) : NaN;
    if (
      !Number.isFinite(time) ||
      !/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(String(body.deviceChangedAt))
    ) {
      return violation('invalid_device', 'deviceChangedAt must be an ISO 8601 time with a zone.');
    }
    deviceChangedAt = time;
  }
  return { ok: true, value: { actor: { kind: 'device', id }, deviceChangedAt } };
}

export function isObject(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

export function violation<Code extends string>(
  code: Code,
  message: string,
): { ok: false; code: Code; message: string } {
  return { ok: false, code, message };
}
