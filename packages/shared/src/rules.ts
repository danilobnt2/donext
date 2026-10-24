import type { EntityItem, EntitySchema, Fields, RuleContext } from './entity';

/*
 * The rules for creating and changing items, in one place. The server enforces them on every
 * change it receives; a device runs the same functions to decide what to show and what to
 * refuse before anything is sent.
 */

export interface Refusal {
  ok: false;
  reason: 'invalid_field' | 'rule_violation';
  message: string;
}

export type CreateCheck = { ok: true; fields: Fields } | Refusal;

/** `changedFields` is empty when the change would leave the item as it is. */
export type UpdateCheck = { ok: true; fields: Fields; changedFields: string[] } | Refusal;

const refuse = (reason: Refusal['reason'], message: string): Refusal => ({
  ok: false,
  reason,
  message,
});

/** Checks the fields for a new item and returns all of them, with defaults filled in. */
export function checkCreate(schema: EntitySchema, input: Fields, ctx: RuleContext): CreateCheck {
  for (const name of Object.keys(input)) {
    if (!Object.hasOwn(schema.fields, name)) {
      return refuse('invalid_field', `A ${schema.label} has no field “${name}”.`);
    }
  }

  const fields: Fields = {};
  for (const [name, spec] of Object.entries(schema.fields)) {
    if (!Object.hasOwn(input, name)) {
      if (spec.required) return refuse('invalid_field', `${name} is required.`);
      fields[name] = spec.default ?? null;
      continue;
    }
    if (spec.writable === 'never') return refuse('invalid_field', `${name} cannot be set.`);
    const parsed = spec.parse(input[name]);
    if (!parsed.ok) return refuse('invalid_field', parsed.message);
    fields[name] = parsed.value;
  }

  const violation = schema.validate?.(fields, ctx, null);
  return violation ? refuse('rule_violation', violation.message) : { ok: true, fields };
}

/** Checks changes to an existing item. Fields the changes leave out are untouched. */
export function checkUpdate(
  schema: EntitySchema,
  current: EntityItem,
  input: Fields,
  ctx: RuleContext,
): UpdateCheck {
  const fields: Fields = { ...current.fields };
  const changedFields: string[] = [];
  for (const [name, value] of Object.entries(input)) {
    const spec = Object.hasOwn(schema.fields, name) ? schema.fields[name] : undefined;
    if (!spec) return refuse('invalid_field', `A ${schema.label} has no field “${name}”.`);
    if (spec.writable === 'never') return refuse('invalid_field', `${name} cannot be set.`);
    if (spec.writable === 'on-create') return refuse('invalid_field', `${name} cannot be changed.`);
    const parsed = spec.parse(value);
    if (!parsed.ok) return refuse('invalid_field', parsed.message);
    if (parsed.value !== current.fields[name]) {
      fields[name] = parsed.value;
      changedFields.push(name);
    }
  }

  if (changedFields.length > 0) {
    const violation = schema.validate?.(fields, ctx, current);
    if (violation) return refuse('rule_violation', violation.message);
  }
  return { ok: true, fields, changedFields };
}
