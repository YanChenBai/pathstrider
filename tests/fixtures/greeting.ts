import { z } from 'zod';

import { defineValidatedHandler } from '../../src/index.ts';

export default defineValidatedHandler({
  validate: { query: z.object({ name: z.string() }) },
  responses: { 200: z.object({ name: z.string() }).describe('Greeting') },
  handler: ({ query }) => ({ name: query.name }),
});
