/*
 * The domain model, as far as code that handles any kind of data needs to know it. An item has
 * an id, a revision and a bag of fields. What each kind of item may contain, and the rules for
 * changing it, come from an `EntitySchema`, so a new kind of data is a new schema.
 *
 * Nothing here is about syncing: sync carries these items and adds its own versioning.
 */

export type FieldValue = string | number | boolean | null;
export type Fields = Record<string, FieldValue>;

export interface EntityItem {
  id: string;
  /** The name of the item's schema, for example `todo`. */
  entity: string;
  /** Domain revision: 1 when created, one more on every accepted change. */
  rev: number;
  createdAt: string;
  updatedAt: string;
  fields: Fields;
}

export type ParseResult = { ok: true; value: FieldValue } | { ok: false; message: string };

export interface FieldSpec {
  /** Checks a value and returns it in its stored form, for example a trimmed title. */
  parse(value: unknown): ParseResult;
  /** A create must give this field. */
  required?: boolean;
  /** The value of a field a create leaves out. Without one, the field starts as null. */
  default?: FieldValue;
  /**
   * What a person may do with the field: set it at any time (the default), set it only when
   * creating the item, or never, because the server derives it.
   */
  writable?: 'always' | 'on-create' | 'never';
}

/** A rule an item broke that the field checks cannot see, for example a missing parent. */
export interface Violation {
  message: string;
}

/** Lets a rule look at other items. */
export interface RuleContext {
  get(id: string): EntityItem | undefined;
}

export interface EntitySchema {
  name: string;
  /** What people call one of these in messages, for example `To-Do`. */
  label: string;
  fields: Record<string, FieldSpec>;
  /** The most items of this kind there can be. Only the server can enforce it. */
  limit?: { max: number; message: string };
  /** Runs on the fields an item would have after a create or a real change. `current` is null for a create. */
  validate?(next: Fields, ctx: RuleContext, current: EntityItem | null): Violation | null;
}

/** The schemas in use, by name. */
export type Schemas = Readonly<Record<string, EntitySchema>>;

export function schemaFor(schemas: Schemas, entity: string): EntitySchema | undefined {
  return Object.hasOwn(schemas, entity) ? schemas[entity] : undefined;
}
