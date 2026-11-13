import type { ApiErrorBody } from '@quickhub/shared';
import type { ZodType } from 'zod';

type Code = ApiErrorBody['error']['code'];
type Extras = Omit<ApiErrorBody['error'], 'code' | 'message'>;

/** Throw this anywhere in a route; the error middleware turns it into JSON. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: Code,
    message: string,
    public extras: Extras = {},
  ) {
    super(message);
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, ...this.extras } };
  }
}

/** Validate a request body. On failure, reply 400 with one message per field. */
export function parse<T>(schema: ZodType<T, unknown>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  throw new ApiError(400, 'validation', 'Some fields are invalid', { fields });
}
