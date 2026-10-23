import type { EntityItem, EntitySchema, Fields, RuleContext } from './entity';
import type { RejectReason } from './sync';

/*
 * The rules for creating and changing items, in one place. The server enforces them on every
 * change it receives; a device runs the very same functions to decide what to show and what to
 * refuse before anything is sent.
 */

export interface Refusal {
  ok: false;
  reason: RejectReason;
  message: string;
}

export type CreateCheck = { ok: true; fields: Fields } | Refusal;

/** `changedFields` is empty when the change would leave the item as it is. */
export type UpdateCheck = { ok: true; next: Fields; changedFields: string[] } | Refusal;

const refuse = (reason: RejectReason, message: string): Refusal => ({ ok: false, reason, message });

/** Checks the fields for a new item and returns all of them, with defaults filled in. */
export function checkCreate(schema: EntitySchema, input: Fields, ctx: RuleContext): CreateCheck {
  for (const name of Object.keys(input)) {
    if (!Object.hasOwn(schema.fields, name)) {
      return refuse('invalid_field', `A ${schema.label} has no field “${name}”.`);
    }
  }

  const fields: Fields = {};
  for (const [name, spec] of Object.entries(schema.fields)) {
    const mode = spec.create ?? 'optional';
    if (!Object.hasOwn(input, name)) {
      if (mode === 'required') return refuse('invalid_field', `${name} is required.`);
      fields[name] = spec.default ?? null;
      continue;
    }
    if (mode === 'forbidden') {
      return refuse('invalid_field', `${name} cannot be set when creating a ${schema.label}.`);
    }
    const parsed = spec.parse(input[name]);
    if (!parsed.ok) return refuse('invalid_field', parsed.message);
    fields[name] = parsed.value;
  }

  const violation = schema.validate?.(fields, ctx, null);
  return violation ? refuse('rule_violation', violation.message) : { ok: true, fields };
}

/** Checks changes to an existing item. Fields the changes do not name are left alone. */
export function checkUpdate(
  schema: EntitySchema,
  current: EntityItem,
  input: Fields,
  ctx: RuleContext,
): UpdateCheck {
  const { terminal } = schema;
  if (terminal && current.fields[terminal.field] === terminal.value) {
    const onlyRepeatsIt = Object.entries(input).every(
      ([name, value]) => name === terminal.field && value === terminal.value,
    );
    return onlyRepeatsIt
      ? { ok: true, next: current.fields, changedFields: [] }
      : refuse('item_locked', terminal.message);
  }

  const next: Fields = { ...current.fields };
  const changedFields: string[] = [];
  for (const [name, value] of Object.entries(input)) {
    const spec = Object.hasOwn(schema.fields, name) ? schema.fields[name] : undefined;
    if (!spec) return refuse('invalid_field', `A ${schema.label} has no field “${name}”.`);
    if (spec.immutable) return refuse('invalid_field', `${name} cannot be changed.`);
    if (spec.deviceValues && !spec.deviceValues.includes(value)) {
      return refuse('invalid_field', `${name} cannot be set to that value.`);
    }
    const parsed = spec.parse(value);
    if (!parsed.ok) return refuse('invalid_field', parsed.message);
    if (parsed.value !== current.fields[name]) {
      next[name] = parsed.value;
      changedFields.push(name);
    }
  }

  if (changedFields.length > 0) {
    const violation = schema.validate?.(next, ctx, current);
    if (violation) return refuse('rule_violation', violation.message);
  }
  return { ok: true, next, changedFields };
}
