const NAME_SAFE = /^[A-Za-z0-9._/-]+$/;

/** Names reaching git/docker must be inert: no shell metacharacters, no path traversal. */
export function assertSafeName(kind: string, value: string): void {
  if (!value || !NAME_SAFE.test(value) || value.includes('..') || value.startsWith('-')) {
    throw new Error(`Unsafe ${kind} name: ${JSON.stringify(value)}`);
  }
}

export function isSafeName(value: string): boolean {
  try {
    assertSafeName('name', value);
    return true;
  } catch {
    return false;
  }
}
