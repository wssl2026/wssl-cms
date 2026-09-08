import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { pageSchema } from './lib/page-schema';

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: pageSchema,
});

export const collections = { pages };
