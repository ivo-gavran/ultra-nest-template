import { z } from 'zod';

export const greetingSchema = z.strictObject({
  name: z.string().min(1).max(80),
});

export type Greeting = z.infer<typeof greetingSchema>;
