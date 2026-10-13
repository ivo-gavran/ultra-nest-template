import { z } from 'zod';

export const sessionParamsSchema = z.strictObject({ id: z.uuid() });
export const sessionQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.uuid().optional(),
});
export const sessionPageSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      id: z.uuid(),
      createdAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      status: z.enum(['active', 'expired', 'revoked']),
      current: z.boolean(),
    }),
  ),
  nextCursor: z.uuid().nullable(),
});
export type SessionParams = z.infer<typeof sessionParamsSchema>;
export type SessionQuery = z.infer<typeof sessionQuerySchema>;
export type SessionPage = z.infer<typeof sessionPageSchema>;

// Input is exclusively the public decorator's verified provider context.
export function currentSessionId(context: unknown): string | undefined {
  const parsed = z.object({ sid: z.uuid() }).safeParse(context);
  return parsed.success ? parsed.data.sid : undefined;
}
