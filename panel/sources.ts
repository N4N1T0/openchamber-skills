// Where skills come from, how their ID is derived, and which one OpenCode
// actually loads when two sources define the same ID.
//
// Everything here is pure, so `bun test` can check the rules without a host.
// The reading itself is in main.ts, which walks these roots with the file API.

export type Scope = 'global' | 'project';
export type SourceId = 'opencode' | 'claude' | 'agents';

export type Source = {
  id: SourceId;
  /** The root OpenCode searches, per scope. A project root is project-relative. */
  dir: Record<Scope, string>;
  /** Shown on a row when the skill does not come from OpenCode's own folder. */
  badge: string | null;
};

/**
 * Lower precedence first. OpenCode registers sources in this order and selects
 * a skill by ID, so when two sources hold `git-release` the later one is the
 * one that loads. Explicit `skills` config entries come after all of these;
 * this panel does not read them.
 */
export const SOURCES: Source[] = [
  {
    id: 'claude',
    dir: { global: '~/.claude/skills', project: '.claude/skills' },
    badge: '.claude',
  },
  {
    id: 'agents',
    dir: { global: '~/.agents/skills', project: '.agents/skills' },
    badge: '.agents',
  },
  {
    id: 'opencode',
    dir: { global: '~/.config/opencode/skills', project: '.opencode/skills' },
    badge: null,
  },
];

export const sourceById = (id: SourceId): Source =>
  SOURCES.find((source) => source.id === id) ?? SOURCES[SOURCES.length - 1]!;

/** OpenCode stops searching six directories below a source root. */
export const MAX_DEPTH = 6;

/** Hidden entries and `node_modules` are skipped, as OpenCode skips them. */
export const skipped = (name: string): boolean => name.startsWith('.') || name === 'node_modules';

/**
 * The ID is the path, not the frontmatter `name`: `git-release.md` and
 * `git-release/SKILL.md` are both `git-release`, and `teams/release/SKILL.md`
 * is `release`.
 */
export const idOf = (segments: string[]): string => segments[segments.length - 1] ?? '';

/** The shape a portable skill ID should have (1–64 lowercase kebab-case). */
export const ID_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const isUsableId = (id: string): boolean => ID_SHAPE.test(id) && id.length <= 64;

/**
 * Mark every skill an equally named one later in the list overrides. `found`
 * must be in registration order, lowest precedence first, so the last entry
 * with an ID is the live one.
 */
export const markShadowed = <T extends { id: string }>(found: T[]): (T & { shadowed: boolean })[] => {
  const live = new Map<string, number>();
  found.forEach((item, index) => live.set(item.id, index));
  return found.map((item, index) => ({ ...item, shadowed: live.get(item.id) !== index }));
};

/** A folder with a SKILL.md, or a single markdown file at a source root. */
export type SkillForm = 'dir' | 'file';

export type Found = {
  /** The path under the source root, in segments. */
  segments: string[];
  form: SkillForm;
  /** The markdown file to read and write. */
  path: string;
  /** The skill's own folder, for a folder skill; what deleting removes. */
  dir: string | null;
};

export type ListDir = (path: string) => Promise<{ name: string; kind: string }[]>;

/**
 * Walk one source root the way OpenCode does: a markdown file at the root is a
 * skill, a folder holding a SKILL.md is one skill and is not searched further,
 * any other folder is a grouping folder, and the search stops six levels down.
 * A folder it cannot list simply holds no skills.
 */
export const findSkills = async (rootDir: string, list: ListDir): Promise<Found[]> => {
  const found: Found[] = [];

  const walk = async (segments: string[]): Promise<void> => {
    const here = [rootDir, ...segments].join('/');
    let entries: { name: string; kind: string }[];
    try {
      entries = await list(here);
    } catch {
      return;
    }

    if (segments.length > 0 && entries.some((entry) => entry.kind === 'file' && entry.name === 'SKILL.md')) {
      found.push({ segments, form: 'dir', path: `${here}/SKILL.md`, dir: here });
      return;
    }

    for (const entry of entries) {
      if (skipped(entry.name)) continue;
      if (
        entry.kind === 'file' &&
        segments.length === 0 &&
        entry.name !== 'SKILL.md' &&
        entry.name.toLowerCase().endsWith('.md')
      ) {
        found.push({
          segments: [entry.name.slice(0, -3)],
          form: 'file',
          path: `${here}/${entry.name}`,
          dir: null,
        });
        continue;
      }
      if (entry.kind === 'directory' && segments.length < MAX_DEPTH) {
        await walk([...segments, entry.name]);
      }
    }
  };

  await walk([]);
  return found;
};

/**
 * True when a `metadata:` block switches `opencode/autoinvoke` off. That key
 * wins over `disable-model-invocation`, and it lives inside a nested block the
 * frontmatter writer never rewrites, so the panel only reports it.
 */
export const autoinvokeOff = (metadataLines: string[]): boolean =>
  metadataLines.some((line) => /opencode\/autoinvoke["']?\s*:\s*(?:false|'false'|"false")/.test(line));
