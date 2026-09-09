import { z } from 'astro/zod';

export const PATH_PATTERN = /^$|^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

export const pageSchema = z.object({
  title: z.string().min(1),
  path: z.string().regex(PATH_PATTERN, 'lowercase letters, digits, dashes and slashes only'),
  description: z.string().optional(),
  draft: z.boolean().default(false),
  updated: z.coerce.date().optional(),
  legacyUrl: z.string().optional(),
});

export type PageFrontmatter = z.infer<typeof pageSchema>;

/** Frontmatter keys + `body`; the Decap config test checks its fields against this list. */
export const PAGE_FIELD_NAMES = ['title', 'path', 'description', 'draft', 'updated', 'legacyUrl', 'body'] as const;
