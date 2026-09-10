export interface NavNode { label: string; href: string; children?: NavNode[] }
export interface Crumb { label: string; href: string }

const SECTION_LABELS: Record<string, string> = {
  programs: 'Programs',
  registration: 'Registration',
  schedules: 'Schedules',
  fields: 'Fields',
  volunteers: 'Volunteers',
  about: 'About',
};

function trailTo(nodes: NavNode[], href: string): NavNode[] | null {
  for (const node of nodes) {
    if (node.href === href) return [node];
    const below = trailTo(node.children ?? [], href);
    if (below) return [node, ...below];
  }
  return null;
}

/**
 * The trail the legacy site showed above every inner page: Home, then each navigation
 * ancestor, then the page itself, all labelled as the navigation labels them. A page that
 * is not in the navigation (a page reached only by link) still gets Home / its section /
 * its own title, so the visitor always sees where they are.
 */
export function breadcrumbFor(nav: NavNode[], url: string, title: string): Crumb[] {
  const home: Crumb = { label: 'Home', href: '/' };
  const trail = trailTo(nav, url);
  if (trail) return [home, ...trail.map(({ label, href }) => ({ label, href }))];
  const section = url.split('/')[1] ?? '';
  const sectionHref = `/${section}/`;
  const sectionNode = nav.find((n) => n.href === sectionHref);
  const crumbs: Crumb[] = [home];
  if (section) crumbs.push({ label: sectionNode?.label ?? SECTION_LABELS[section] ?? section, href: sectionHref });
  if (url !== sectionHref) crumbs.push({ label: title, href: url });
  return crumbs;
}
