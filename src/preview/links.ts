import { primaryPort, type Recipe } from './recipes.js';

/** One clickable address of a preview, as the API, UI and MCP show it. */
export interface PreviewLink {
  label: string;
  url: string;
  port_id: string;
  primary: boolean;
}

type RecipePorts = Pick<Recipe, 'ports'>;

function hostUrl(port: number, path = '/'): string {
  // The root link keeps the form of `preview.url` (no trailing slash).
  return `http://127.0.0.1:${port}${path === '/' ? '' : path}`;
}

/**
 * Every link a preview exposes: the primary port's links first (its first link
 * marked primary), then the other ports in recipe order. Ports the preview
 * never allocated, and ports with `link: false`, are skipped. Without a usable recipe, each allocated port
 * gets one root link labelled with its id, and the port behind `url` stays
 * primary.
 */
export function previewLinks(
  ports: Record<string, number>,
  recipe: RecipePorts | null,
  url: string | null = null,
): PreviewLink[] {
  if (!recipe) {
    const entries = Object.entries(ports);
    const primaryId = url === null ? undefined : entries.find(([, port]) => hostUrl(port) === url)?.[0];
    const ordered = [...entries.filter(([id]) => id === primaryId), ...entries.filter(([id]) => id !== primaryId)];
    return ordered.map(([id, port]) => ({ label: id, url: hostUrl(port), port_id: id, primary: id === primaryId }));
  }

  const primaryId = primaryPort(recipe).id;
  const ordered = [...recipe.ports.filter((p) => p.id === primaryId), ...recipe.ports.filter((p) => p.id !== primaryId)];
  const links: PreviewLink[] = [];
  for (const port of ordered) {
    const host = ports[port.id];
    if (host === undefined || port.link === false) continue;
    const entries = port.links ?? [{ label: port.label ?? port.id, path: '/' }];
    entries.forEach((link, index) => {
      links.push({
        label: link.label,
        url: hostUrl(host, link.path),
        port_id: port.id,
        primary: port.id === primaryId && index === 0,
      });
    });
  }
  return links;
}
