/**
 * Atlassian Document Format to plain text.
 *
 * Jira Cloud returns descriptions and comments as an ADF tree, not as text.
 * The output is plain text with light Markdown, because that is what the review
 * prompt already expects from every other tracker. Unknown node types are not
 * an error: they recurse into `content` so a new Atlassian node type degrades
 * to its text instead of vanishing.
 */

export interface AdfMark {
  type?: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  marks?: AdfMark[];
  attrs?: Record<string, unknown>;
}

function attrString(node: AdfNode, key: string): string {
  const value = node.attrs?.[key];
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function applyMarks(text: string, marks: AdfMark[]): string {
  let out = text;
  // Code first so the backticks sit inside any emphasis, link last so the
  // whole styled run becomes the link label.
  if (marks.some((m) => m.type === 'code')) out = `\`${out}\``;
  if (marks.some((m) => m.type === 'strong')) out = `**${out}**`;
  if (marks.some((m) => m.type === 'em')) out = `*${out}*`;
  if (marks.some((m) => m.type === 'strike')) out = `~~${out}~~`;
  const link = marks.find((m) => m.type === 'link');
  const href = link ? attrString({ attrs: link.attrs }, 'href') : '';
  if (href) out = `[${out}](${href})`;
  return out;
}

function renderInline(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map(renderInlineNode).join('');
}

function renderInlineNode(node: AdfNode): string {
  switch (node.type) {
    case 'text': {
      const text = node.text ?? '';
      return node.marks?.length ? applyMarks(text, node.marks) : text;
    }
    case 'hardBreak':
      return '\n';
    case 'mention': {
      const name = attrString(node, 'text') || attrString(node, 'displayName') || attrString(node, 'id');
      return name ? (name.startsWith('@') ? name : `@${name}`) : '';
    }
    case 'emoji':
      return attrString(node, 'text') || attrString(node, 'shortName');
    case 'date':
      return attrString(node, 'timestamp');
    case 'status':
      return attrString(node, 'text');
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return attrString(node, 'url');
    default:
      return node.content ? renderInline(node.content) : (node.text ?? '');
  }
}

function indent(text: string, prefix: string, firstPrefix = prefix): string {
  const lines = text.split('\n');
  return lines.map((line, i) => `${i === 0 ? firstPrefix : prefix}${line}`).join('\n');
}

function renderList(node: AdfNode, ordered: boolean): string {
  const items = node.content ?? [];
  return items
    .map((item, i) => {
      const marker = ordered ? `${i + 1}. ` : '- ';
      const body = renderBlocks(item.content ?? [item]);
      return indent(body, ' '.repeat(marker.length), marker);
    })
    .join('\n');
}

function renderBlock(node: AdfNode): string {
  switch (node.type) {
    case 'paragraph':
      return renderInline(node.content);
    case 'heading': {
      const level = Number(node.attrs?.['level'] ?? 1);
      const hashes = '#'.repeat(Math.min(Math.max(Number.isFinite(level) ? level : 1, 1), 6));
      return `${hashes} ${renderInline(node.content)}`.trim();
    }
    case 'bulletList':
      return renderList(node, false);
    case 'orderedList':
      return renderList(node, true);
    case 'listItem':
      return indent(renderBlocks(node.content), '  ', '- ');
    case 'taskList':
    case 'decisionList':
      return (node.content ?? []).map((item) => `- ${renderInline(item.content)}`).join('\n');
    case 'codeBlock': {
      const language = attrString(node, 'language');
      const code = (node.content ?? []).map((c) => c.text ?? '').join('');
      return `\`\`\`${language}\n${code}\n\`\`\``;
    }
    case 'blockquote':
      return indent(renderBlocks(node.content), '> ');
    case 'rule':
      return '---';
    case 'table':
      return (node.content ?? []).map(renderBlock).filter(Boolean).join('\n');
    case 'tableRow':
      return (node.content ?? []).map((cell) => renderBlocks(cell.content).replace(/\n+/g, ' ')).join(' | ');
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return '';
    case 'panel':
    case 'expand':
    case 'nestedExpand':
      return renderBlocks(node.content);
    default:
      if (node.content) return renderBlocks(node.content);
      return node.text ?? '';
  }
}

function renderBlocks(nodes: AdfNode[] | undefined): string {
  return (nodes ?? [])
    .map(renderBlock)
    .filter((block) => block.trim().length > 0)
    .join('\n\n');
}

/** Accepts an ADF document, a bare node, or a plain string (older Jira APIs). */
export function adfToText(doc: unknown): string {
  if (doc === null || doc === undefined) return '';
  if (typeof doc === 'string') return doc.trim();
  if (Array.isArray(doc)) return renderBlocks(doc as AdfNode[]).trim();
  if (typeof doc !== 'object') return String(doc);
  const node = doc as AdfNode;
  const text = node.content ? renderBlocks(node.content) : renderBlock(node);
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
