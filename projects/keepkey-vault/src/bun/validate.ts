import type { z } from 'zod'
import { HttpError } from './auth'

/**
 * Parse and validate a request body against a Zod schema.
 * Throws HttpError(400) on validation failure (caught by rest-api.ts error handler).
 */
export async function parseRequest<T extends z.ZodType>(
  req: Request,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new HttpError(400, 'Invalid JSON body')
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map((i: any) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new HttpError(400, `Validation error: ${issues}`)
  }
  return result.data
}

/**
 * Soft-validate a response against a Zod schema.
 * Logs a warning on mismatch but ALWAYS returns the original data — never blocks responses.
 */
export function validateResponse<T extends z.ZodType>(
  data: unknown,
  schema: T,
  route: string,
): unknown {
  const result = schema.safeParse(data)
  if (!result.success) {
    const issues = result.error.issues
      .map((i: any) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    console.warn(`[REST] Response validation warning on ${route}: ${issues}`)
  }
  return data
}
