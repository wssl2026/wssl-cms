export function sectionOf(id: string): string {
  return id.split('/')[0];
}

/** URL for a content entry: `/section/path/`, or `/section/` when path is empty. */
export function urlFor(id: string, path: string): string {
  const section = sectionOf(id);
  return path === '' ? `/${section}/` : `/${section}/${path}/`;
}
