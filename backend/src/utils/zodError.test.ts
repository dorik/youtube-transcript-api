import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodValidationDetails } from './zodError';

describe('zodValidationDetails', () => {
  it('keys per-field issues under `issues`', () => {
    const schema = z.object({ url: z.string().min(1) });
    const result = schema.safeParse({ url: '' });
    expect(result.success).toBe(false);
    if (result.success) return;

    const details = zodValidationDetails(result.error);
    expect(details.issues).toHaveProperty('url');
    expect(details).not.toHaveProperty('errors');
  });

  it('surfaces path-less object-level issues under `errors`', () => {
    // A `.superRefine` issue with no `path` — e.g. the bulk route's
    // "exactly one source" rule. `.flatten().fieldErrors` drops these, so
    // the route used to answer with an empty `issues:{}` and no explanation.
    const schema = z
      .object({ a: z.string().optional(), b: z.string().optional() })
      .superRefine((val, ctx) => {
        if (!val.a && !val.b) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Provide exactly one of: a, b',
          });
        }
      });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;

    const details = zodValidationDetails(result.error);
    expect(details.errors).toEqual(['Provide exactly one of: a, b']);
  });
});
