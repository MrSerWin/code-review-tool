/**
 * HTML to readable text, for trackers that store rich text as HTML.
 *
 * Deliberately small: block tags become line breaks, list items get a bullet,
 * links keep their target, everything else is dropped and entities are decoded.
 * The result feeds a prompt, so readability matters and markup does not.
 */

const BLOCK_TAGS = 'p|div|section|article|header|footer|tr|table|ul|ol|dl|h[1-6]|blockquote|pre';

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[lower] ?? match;
  });
}

export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  let text = html;

  // Script and style carry no readable content but plenty of noise.
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
    const clean = label.replace(/<[^>]+>/g, '').trim();
    return clean && clean !== href ? `${clean} (${href})` : href;
  });
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  // Table cells would otherwise run into each other.
  text = text.replace(/<\/t[dh]\s*>/gi, ' | ');
  text = text.replace(new RegExp(`</(?:${BLOCK_TAGS})\\s*>`, 'gi'), '\n\n');
  text = text.replace(new RegExp(`<(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').replace(/\s*\|\s*$/, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
