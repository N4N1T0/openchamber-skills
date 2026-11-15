import { describe, expect, test } from 'bun:test';
import {
  autoinvokeOff,
  findSkills,
  idOf,
  isUsableId,
  markShadowed,
  sourceById,
  SOURCES,
  type ListDir,
} from './sources';

/** A fake source root: folder path → entries, as `listDir` answers. */
const tree = (folders: Record<string, string[]>): ListDir => async (path) => {
  const entries = folders[path];
  if (!entries) throw new Error(`no such folder: ${path}`);
  return entries.map((name) =>
    name.endsWith('/')
      ? { name: name.slice(0, -1), kind: 'directory' }
      : { name, kind: 'file' },
  );
};

describe('ids', () => {
  test('the last path segment is the id, not the frontmatter name', () => {
    expect(idOf(['git-release'])).toBe('git-release');
    expect(idOf(['teams', 'release'])).toBe('release');
    expect(idOf([])).toBe('');
  });

  test('a portable id is lowercase kebab-case, up to 64 characters', () => {
    expect(isUsableId('git-release')).toBe(true);
    expect(isUsableId('seo2')).toBe(true);
    expect(isUsableId('Git-Release')).toBe(false);
    expect(isUsableId('git_release')).toBe(false);
    expect(isUsableId('git release')).toBe(false);
    expect(isUsableId('-release')).toBe(false);
    expect(isUsableId('release-')).toBe(false);
    expect(isUsableId('../release')).toBe(false);
    expect(isUsableId('')).toBe(false);
    expect(isUsableId('a'.repeat(65))).toBe(false);
  });
});

describe('precedence', () => {
  test('sources are ordered lowest precedence first', () => {
    expect(SOURCES.map((source) => source.id)).toEqual(['claude', 'agents', 'opencode']);
    expect(sourceById('opencode').dir.global).toBe('~/.config/opencode/skills');
    expect(sourceById('claude').dir.project).toBe('.claude/skills');
    expect(sourceById('opencode').badge).toBe(null);
  });

  test('the last skill with an id wins and the earlier ones are marked', () => {
    const marked = markShadowed([
      { id: 'git-release', source: 'claude' },
      { id: 'seo', source: 'claude' },
      { id: 'git-release', source: 'opencode' },
    ]);
    expect(marked.map((item) => [item.source, item.shadowed])).toEqual([
      ['claude', true],
      ['claude', false],
      ['opencode', false],
    ]);
  });

  test('without a duplicate nothing is marked', () => {
    expect(markShadowed([{ id: 'a' }, { id: 'b' }]).every((item) => !item.shadowed)).toBe(true);
  });
});

describe('finding skills in a source root', () => {
  const ROOT = '~/.config/opencode/skills';

  test('both shapes are found, and a folder skill is not searched inside', async () => {
    const found = await findSkills(
      ROOT,
      tree({
        [ROOT]: ['review.md', 'git-release/', 'README.txt'],
        [`${ROOT}/git-release`]: ['SKILL.md', 'scripts/', 'references/'],
      }),
    );
    expect(found).toEqual([
      { segments: ['review'], form: 'file', path: `${ROOT}/review.md`, dir: null },
      {
        segments: ['git-release'],
        form: 'dir',
        path: `${ROOT}/git-release/SKILL.md`,
        dir: `${ROOT}/git-release`,
      },
    ]);
  });

  test('a grouping folder is searched, and its SKILL.md keeps the last segment as its id', async () => {
    const found = await findSkills(
      ROOT,
      tree({
        [ROOT]: ['teams/'],
        [`${ROOT}/teams`]: ['release/', 'notes.md'],
        [`${ROOT}/teams/release`]: ['SKILL.md'],
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.segments).toEqual(['teams', 'release']);
    expect(idOf(found[0]!.segments)).toBe('release');
    // A markdown file that is not at the source root is not a skill.
    expect(found.some((entry) => entry.path.endsWith('notes.md'))).toBe(false);
  });

  test('hidden folders, node_modules and unreadable folders are skipped', async () => {
    const found = await findSkills(
      ROOT,
      tree({
        [ROOT]: ['.hidden/', 'node_modules/', 'gone/', 'ok/'],
        [`${ROOT}/ok`]: ['SKILL.md'],
        // `.hidden`, `node_modules` and `gone` are never listed or throw.
      }),
    );
    expect(found.map((entry) => entry.segments)).toEqual([['ok']]);
  });

  test('a folder with no SKILL.md and no skills below it yields nothing', async () => {
    const found = await findSkills(ROOT, tree({ [ROOT]: ['empty/'], [`${ROOT}/empty`]: ['notes.md'] }));
    expect(found).toEqual([]);
  });

  test('the search stops six folders below the root', async () => {
    const deep: Record<string, string[]> = { [ROOT]: ['a/'] };
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    names.forEach((name, index) => {
      const path = [ROOT, ...names.slice(0, index + 1)].join('/');
      deep[path] = index + 1 < names.length ? [`${names[index + 1]}/`] : ['SKILL.md'];
    });
    expect(await findSkills(ROOT, tree(deep))).toEqual([]);

    // One level shallower, the same tree does hold a skill.
    const within: Record<string, string[]> = { [ROOT]: ['a/'] };
    const shorter = names.slice(0, 6);
    shorter.forEach((name, index) => {
      const path = [ROOT, ...shorter.slice(0, index + 1)].join('/');
      within[path] = index + 1 < shorter.length ? [`${shorter[index + 1]}/`] : ['SKILL.md'];
    });
    expect((await findSkills(ROOT, tree(within))).map((entry) => idOf(entry.segments))).toEqual(['f']);
  });
});

describe('metadata.opencode/autoinvoke', () => {
  test('false, quoted or not, means the model never lists the skill', () => {
    expect(autoinvokeOff(['metadata:', '  opencode/autoinvoke: false'])).toBe(true);
    expect(autoinvokeOff(['metadata:', "  opencode/autoinvoke: 'false'"])).toBe(true);
    expect(autoinvokeOff(['metadata:', '  "opencode/autoinvoke": false'])).toBe(true);
    expect(autoinvokeOff(['metadata: { opencode/autoinvoke: false }'])).toBe(true);
  });

  test('true, another key, or no metadata at all leaves the switch in charge', () => {
    expect(autoinvokeOff(['metadata:', '  opencode/autoinvoke: true'])).toBe(false);
    expect(autoinvokeOff(['metadata:', '  team: platform'])).toBe(false);
    expect(autoinvokeOff([])).toBe(false);
  });
});
