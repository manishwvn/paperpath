import { requiredFields } from '../src/fields.ts';
import type { Field, Validation } from '../src/domain.ts';

export type NextResolution = { field: Field; kind: 'conflict' | 'missing' };

export function nextResolution(validation: Validation | null): NextResolution | null {
  if (!validation) return null;
  const conflict = validation.conflicts[0];
  if (conflict) return { field: conflict, kind: 'conflict' };
  const missing = validation.missing.find((field) => requiredFields.some((requiredField) => requiredField === field));
  return missing ? { field: missing, kind: 'missing' } : null;
}
