import { z } from 'zod';
export const greeting = z.object({ name: z.string() }).describe('Imported greeting');
