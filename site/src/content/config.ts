import { defineCollection, z } from 'astro:content';

const docs = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    order: z.number().int(),
    summary: z.string(),
    source: z.string(),
  }),
});

export const collections = { docs };
