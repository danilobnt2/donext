/*
 * What the sync mechanism knows about the data it carries. It replicates "entity items": records
 * with an id, a revision and a bag of fields. It knows nothing about To-Dos or Tasks. What each
 * kind of item may contain, and the rules about changing it, come from an `EntitySchema`
 * registered by name, so a new kind of data is a new schema and not a new sync.
 */

export type FieldValue = string | number | boolean | null;
export type Fields = Record<string, FieldValue>;

export interface EntityItem {
  id: string;
  /** The name of the item's schema, for example `todo`. */
  entity: string;
  /** Number of the latest revision; 1 for a new item. */
  rev: number;
  createdAt: string;
  updatedAt: string;
  fields: Fields;
}

export type ParseResult = { ok: true; value: FieldValue } | { ok: false; message: string };

export interface FieldSpec {
  /** Checks a value and returns it in its stored form, for example a trimmed title. */
  parse(value: unknown): ParseResult;
  /** Whether a device must, may or must not give this field when creating an item. */
  create?: 'required' | 'optional' | 'forbidden';
  /** The value of a field a create leaves out. Without one, the field starts as null. */
  default?: FieldValue;
  /** The field can be given when creating but never changed. */
  immutable?: boolean;
  /** When set, a device may write only these values; the server writes the others itself. */
  deviceValues?: readonly FieldValue[];
}

/** A rule an item broke that the field checks cannot see, for example a missing parent. */
export interface Violation {
  message: string;
}

/** Lets a rule look at other items: the server’s, or the device’s with its own changes applied. */
export interface RuleContext {
  get(id: string): EntityItem | undefined;
}

export interface EntitySchema {
  name: string;
  /** What people call one of these in messages, for example `To-Do`. */
  label: string;
  fields: Record<string, FieldSpec>;
  /**
   * A value of a field after which the item is finished: it accepts no more changes, is hidden
   * from views and does not count against `limit`. Asking again for the same value is harmless.
   */
  terminal?: { field: string; value: FieldValue; message: string };
  /** The most live (not terminal) items there can be. Only the server enforces it. */
  limit?: { max: number; message: string };
  /** Runs on the fields an item would have after a create or a real change. `current` is null for a create. */
  validate?(next: Fields, ctx: RuleContext, current: EntityItem | null): Violation | null;
}

/** The schemas in use, by name. */
export type Schemas = Readonly<Record<string, EntitySchema>>;

export function isTerminal(schema: EntitySchema | undefined, item: EntityItem): boolean {
  return (
    schema?.terminal !== undefined && item.fields[schema.terminal.field] === schema.terminal.value
  );
}
