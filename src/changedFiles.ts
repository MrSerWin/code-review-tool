import type { ChangedFile } from './types.js';

// --- the changed-file list ---------------------------------------------------

/**
 * Parses `git diff --numstat -z -M`. A rename is `add\tdel\t\0old\0new\0`;
 * anything else `add\tdel\tpath\0`. Binary files report `-` counts.
 */
export function parseNumstatZ(stdout: string): Map<string, { additions: number | null; deletions: number | null; old_path: string | null }> {
  const out = new Map<string, { additions: number | null; deletions: number | null; old_path: string | null }>();
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!.replace(/^\n+/, '');
    if (!token) continue;
    const m = /^([0-9-]+)\t([0-9-]+)\t(.*)$/s.exec(token);
    if (!m) continue;
    const count = (v: string) => (v === '-' ? null : Number(v));
    let file = m[3]!;
    let oldPath: string | null = null;
    if (!file) {
      oldPath = tokens[i + 1] ?? null;
      file = tokens[i + 2] ?? '';
      i += 2;
    }
    if (file) out.set(file, { additions: count(m[1]!), deletions: count(m[2]!), old_path: oldPath });
  }
  return out;
}

/** Parses `git diff --name-status -z -M`: `S\0path\0`, or `R100\0old\0new\0` for renames and copies. */
export function parseNameStatusZ(stdout: string): { path: string; status: string; old_path: string | null }[] {
  const out: { path: string; status: string; old_path: string | null }[] = [];
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const raw = tokens[i]!.replace(/^\n+/, '');
    if (!raw) continue;
    const status = raw[0]!.toUpperCase();
    if (status === 'R' || status === 'C') {
      const oldPath = tokens[i + 1] ?? '';
      const newPath = tokens[i + 2] ?? '';
      i += 2;
      if (newPath) out.push({ path: newPath, status, old_path: oldPath || null });
    } else {
      const file = tokens[i + 1] ?? '';
      i += 1;
      if (file) out.push({ path: file, status, old_path: null });
    }
  }
  return out;
}

/** The changed files in name-status order, with the numstat counts merged in. */
export function mergeChangedFiles(nameStatus: string, numstat: string): ChangedFile[] {
  const counts = parseNumstatZ(numstat);
  return parseNameStatusZ(nameStatus).map((entry) => {
    const c = counts.get(entry.path);
    return {
      path: entry.path,
      status: entry.status,
      old_path: entry.old_path ?? c?.old_path ?? null,
      additions: c ? c.additions : null,
      deletions: c ? c.deletions : null,
    };
  });
}
