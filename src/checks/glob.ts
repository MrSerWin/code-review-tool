/**
 * Small gitignore-style glob matching for check configs, on repo-relative
 * POSIX paths:
 * - `*` any run of characters except `/`, `?` one such character, `[0-9]` a
 *   class (`[!x]` negated), `{a,b}` alternatives;
 * - `**` as a segment of its own: any number of whole directories;
 * - a pattern without `/` matches the file name at any depth (`*.pyc`);
 * - a pattern ending in `/` matches a path segment at any depth, the last one
 *   included (`.venv/` matches `.venv/bin/python` and a `.venv` symlink);
 * - any other pattern matches the whole path.
 */

function segmentSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) {
        out += '\\[';
        continue;
      }
      let body = glob.slice(i + 1, end);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      out += `[${body.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else if (ch === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) {
        out += '\\{';
        continue;
      }
      out += `(?:${glob.slice(i + 1, end).split(',').map(segmentSource).join('|')})`;
      i = end;
    } else {
      out += ch.replace(/[.+^$()|\\]/g, '\\$&');
    }
  }
  return out;
}

function pathSource(glob: string): string {
  const parts = glob.split('/');
  let out = '';
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    if (part === '**') {
      // `a/**/b`: zero or more directories; a trailing `**`: anything below.
      out += last ? '.*' : '(?:[^/]+/)*';
    } else {
      out += segmentSource(part) + (last ? '' : '/');
    }
  });
  return out;
}

export function globToRegExp(pattern: string): RegExp {
  const glob = pattern.trim().replace(/^\.\//, '').replace(/^\//, '');
  if (glob.endsWith('/')) {
    const dir = glob.slice(0, -1);
    if (!dir.includes('/')) return new RegExp(`(?:^|/)${segmentSource(dir)}(?:/|$)`);
    return new RegExp(`^${pathSource(dir)}(?:/|$)`);
  }
  if (!glob.includes('/')) return new RegExp(`(?:^|/)${segmentSource(glob)}$`);
  return new RegExp(`^${pathSource(glob)}$`);
}

export class GlobSet {
  private readonly res: RegExp[];

  constructor(readonly patterns: readonly string[]) {
    this.res = patterns.filter((p) => p.trim()).map(globToRegExp);
  }

  get empty(): boolean {
    return this.res.length === 0;
  }

  matches(file: string): boolean {
    return this.res.some((re) => re.test(file));
  }

  /** The first pattern that matches, or null. */
  firstMatch(file: string): string | null {
    const index = this.res.findIndex((re) => re.test(file));
    return index < 0 ? null : this.patterns.filter((p) => p.trim())[index]!;
  }
}

/** Included by `include` and not by `exclude`. */
export function selectPaths(paths: readonly string[], include: GlobSet, exclude?: GlobSet): string[] {
  return paths.filter((p) => include.matches(p) && !exclude?.matches(p));
}
