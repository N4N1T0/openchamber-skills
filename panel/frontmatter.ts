// Surgical reader/writer for the YAML frontmatter of a SKILL.md file.
//
// It only understands the top-level scalar keys the panel edits
// (name, description, disable-model-invocation). Anything else — a
// `metadata:` block, `allowed-tools:`, `license:`, comments, key order — is
// carried through untouched, so saving never loses a field this panel does not
// know about.

type Entry = {
  key: string | null; // null for a comment or blank line we just carry over
  lines: string[];
  kind: 'scalar' | 'opaque';
  value: string;
};

export type SkillFile = {
  entries: Entry[];
  hadFrontmatter: boolean;
  body: string;
};

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.\-/]*)\s*:(.*)$/;

const unquote = (raw: string): string => {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text
      .slice(1, -1)
      .replace(/\\(["\\/nrt])/g, (_, char: string) => {
        if (char === 'n') return '\n';
        if (char === 'r') return '\r';
        if (char === 't') return '\t';
        return char;
      });
  }
  return text;
};

const indented = (line: string): boolean => /^[ \t]/.test(line) && line.trim() !== '';

export const parseSkillFile = (text: string): SkillFile => {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { entries: [], hadFrontmatter: false, body: normalized };
  }
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === '---' || line === '...') {
      close = index;
      break;
    }
  }
  if (close === -1) return { entries: [], hadFrontmatter: false, body: normalized };

  const frontmatter = lines.slice(1, close);
  const body = lines.slice(close + 1).join('\n');
  const entries: Entry[] = [];

  let index = 0;
  while (index < frontmatter.length) {
    const line = frontmatter[index]!;
    const match = KEY_LINE.exec(line);
    if (!match || indented(line)) {
      entries.push({ key: null, lines: [line], kind: 'opaque', value: '' });
      index += 1;
      continue;
    }
    const key = match[1]!;
    const head = (match[2] ?? '').trim();
    const taken = [line];
    index += 1;
    while (index < frontmatter.length && indented(frontmatter[index]!)) {
      taken.push(frontmatter[index]!);
      index += 1;
    }
    const continuation = taken.slice(1);
    const blockScalar = head.startsWith('|') || head.startsWith('>');
    if (head === '' || blockScalar) {
      if (continuation.length === 0 && !blockScalar) {
        entries.push({ key, lines: taken, kind: 'scalar', value: '' });
      } else if (blockScalar) {
        const indent = Math.min(
          ...continuation.map((entry) => entry.length - entry.replace(/^[ \t]+/, '').length),
        );
        const kept = continuation.map((entry) => entry.slice(indent));
        // `|` keeps the line breaks, `>` folds them into spaces.
        const joined = head.startsWith('>')
          ? kept.map((entry) => entry.trim()).join(' ').trim()
          : kept.join('\n');
        entries.push({ key, lines: taken, kind: 'scalar', value: joined.replace(/\n+$/, '') });
      } else {
        entries.push({ key, lines: taken, kind: 'opaque', value: '' });
      }
      continue;
    }
    // A plain scalar, possibly folded over the following indented lines.
    const folded = [head, ...continuation.map((entry) => entry.trim())].join(' ').trim();
    entries.push({ key, lines: taken, kind: 'scalar', value: unquote(folded) });
  }

  return { entries, hadFrontmatter: true, body };
};

export const readField = (file: SkillFile, key: string): string | null => {
  const entry = file.entries.find((item) => item.key === key && item.kind === 'scalar');
  return entry ? entry.value : null;
};

export const hasOpaqueField = (file: SkillFile, key: string): boolean =>
  file.entries.some((item) => item.key === key && item.kind === 'opaque');

/**
 * The frontmatter lines of a key exactly as written, so a caller can look
 * inside a nested block the panel never rewrites (`metadata:`).
 */
export const rawLines = (file: SkillFile, key: string): string[] =>
  file.entries.filter((item) => item.key === key).flatMap((item) => item.lines);

/** Top-level keys the panel does not edit, so the editor can say what it keeps. */
export const untouchedKeys = (file: SkillFile, known: string[]): string[] =>
  file.entries
    .map((entry) => entry.key)
    .filter((key): key is string => Boolean(key) && !known.includes(key!));

const BARE = /^(?:true|false|null|-?\d+(?:\.\d+)?)$/;

const formatValue = (key: string, value: string): string[] => {
  if (BARE.test(value)) return [`${key}: ${value}`];
  if (value === '') return [`${key}: ''`];
  if (value.includes('\n')) {
    const lines = value.split('\n').map((line) => (line === '' ? '' : `  ${line}`));
    return [`${key}: |-`, ...lines];
  }
  return [`${key}: '${value.replaceAll("'", "''")}'`];
};

/**
 * Rewrite the file with `updates` applied: a string replaces or adds the key,
 * `null` removes it. Every other line of the frontmatter is kept as written.
 */
export const writeSkillFile = (
  file: SkillFile,
  updates: Record<string, string | null>,
  body: string,
): string => {
  const pending = new Set(Object.keys(updates));
  const out: string[] = [];

  for (const entry of file.entries) {
    if (entry.key && pending.has(entry.key)) {
      pending.delete(entry.key);
      const next = updates[entry.key]!;
      if (next === null) continue; // drop the key
      if (entry.kind === 'opaque') {
        out.push(...entry.lines); // never rewrite a nested block
        continue;
      }
      out.push(...formatValue(entry.key, next));
      continue;
    }
    out.push(...entry.lines);
  }

  for (const key of pending) {
    const next = updates[key];
    if (next === null || next === undefined) continue;
    out.push(...formatValue(key, next));
  }

  const trimmedBody = body.replace(/\r\n?/g, '\n').trim();
  const tail = trimmedBody === '' ? '\n' : `\n${trimmedBody}\n`;
  return `---\n${out.join('\n')}\n---\n${tail}`;
};
