/** zod (v3) → JSON Schema, for the subset tool inputs use. Unsupported types throw, so a new tool can't silently send a wrong schema. */
import { z } from 'zod';

export function toJsonSchema(t: z.ZodTypeAny): Record<string, unknown> {
  const desc = t.description ? { description: t.description } : {};
  if (t instanceof z.ZodOptional || t instanceof z.ZodNullable) return toJsonSchema(t.unwrap());
  if (t instanceof z.ZodDefault) return { ...toJsonSchema(t._def.innerType), ...desc };
  if (t instanceof z.ZodEffects) return toJsonSchema(t._def.schema);
  if (t instanceof z.ZodString) {
    const s: Record<string, unknown> = { type: 'string', ...desc };
    for (const c of t._def.checks) { if (c.kind === 'min') s.minLength = c.value; if (c.kind === 'max') s.maxLength = c.value; }
    return s;
  }
  if (t instanceof z.ZodNumber) {
    const s: Record<string, unknown> = { type: t._def.checks.some(c => c.kind === 'int') ? 'integer' : 'number', ...desc };
    for (const c of t._def.checks) { if (c.kind === 'min') s.minimum = c.value; if (c.kind === 'max') s.maximum = c.value; }
    return s;
  }
  if (t instanceof z.ZodBoolean) return { type: 'boolean', ...desc };
  if (t instanceof z.ZodEnum) return { type: 'string', enum: t._def.values, ...desc };
  if (t instanceof z.ZodLiteral) return { const: t._def.value, ...desc };
  if (t instanceof z.ZodArray) {
    const s: Record<string, unknown> = { type: 'array', items: toJsonSchema(t._def.type), ...desc };
    if (t._def.minLength) s.minItems = t._def.minLength.value;
    if (t._def.maxLength) s.maxItems = t._def.maxLength.value;
    return s;
  }
  if (t instanceof z.ZodObject) {
    const shape = t.shape as Record<string, z.ZodTypeAny>;
    const required = Object.entries(shape).filter(([, v]) => !(v instanceof z.ZodOptional) && !(v instanceof z.ZodDefault)).map(([k]) => k);
    return { type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, toJsonSchema(v)])), required, additionalProperties: false, ...desc };
  }
  throw new Error(`toJsonSchema: unsupported zod type ${t.constructor.name}`);
}
