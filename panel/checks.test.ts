import { describe, expect, test } from 'bun:test';
import { checkSkill, DESCRIPTION_SOFT_LIMIT, type CheckInput } from './checks';

const base: CheckInput = {
  id: 'git-release',
  name: '',
  description: 'Use when preparing release notes, version bumps and GitHub releases.',
  body: '## Workflow\n\n1. Summarize the changes.',
  invocable: true,
  pinnedOff: false,
  isNew: false,
  hadFrontmatter: true,
  sameIdElsewhere: [],
  winner: null,
};

const texts = (input: Partial<CheckInput>) => checkSkill({ ...base, ...input });
const tones = (input: Partial<CheckInput>) => texts(input).map((check) => check.tone);

describe('a healthy skill', () => {
  test('has no checks at all', () => {
    expect(texts({})).toEqual([]);
  });
});

describe('description', () => {
  test('empty is an error', () => {
    expect(tones({ description: '   ' })).toEqual(['error']);
  });

  const padded = (length: number) => `Use when testing. ${'x'.repeat(length - 'Use when testing. '.length)}`;

  test('over the soft limit is a warning that names the number', () => {
    const long = padded(DESCRIPTION_SOFT_LIMIT + 1);
    const found = texts({ description: long });
    expect(found).toHaveLength(1);
    expect(found[0]!.tone).toBe('warning');
    expect(found[0]!.text).toContain(`${DESCRIPTION_SOFT_LIMIT + 1} characters`);
  });

  test('exactly at the limit is fine', () => {
    expect(texts({ description: padded(DESCRIPTION_SOFT_LIMIT) })).toEqual([]);
  });
});

describe('ID and name', () => {
  test('an ID that is not kebab-case is an info, not an error', () => {
    expect(tones({ id: 'Git_Release' })).toEqual(['info']);
  });

  test('a name that differs from the ID is an info that says the ID is what loads', () => {
    const found = texts({ name: 'Git Release' });
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toContain('@git-release');
  });

  test('a name equal to the ID is quiet', () => {
    expect(texts({ name: 'git-release' })).toEqual([]);
  });
});

describe('conflicts', () => {
  test('a new skill whose ID already exists elsewhere is an error', () => {
    const found = texts({ isNew: true, sameIdElsewhere: ['Global'] });
    expect(found[0]).toEqual({
      tone: 'error',
      text: 'git-release is already a skill in Global. Pick another ID.',
    });
  });

  test('an existing skill that is overridden names the winner', () => {
    const found = texts({ winner: '~/.claude/skills' });
    expect(found).toEqual([
      {
        tone: 'warning',
        text: '~/.claude/skills defines git-release too and has higher precedence, so OpenCode loads that one instead.',
      },
    ]);
  });
});

describe('file shape and body', () => {
  test('an existing file without frontmatter is a warning', () => {
    expect(tones({ hadFrontmatter: false })).toEqual(['warning']);
  });

  test('a new skill without frontmatter yet is not warned about it', () => {
    expect(tones({ isNew: true, hadFrontmatter: false })).toEqual([]);
  });

  test('an empty body is a warning', () => {
    expect(tones({ body: '  \n ' })).toEqual(['warning']);
  });
});

describe('trigger wording', () => {
  test('a listed skill whose description never says when to use it is a warning', () => {
    const found = texts({ description: 'Prepare release notes and GitHub releases.' });
    expect(found).toHaveLength(1);
    expect(found[0]!.tone).toBe('warning');
    expect(found[0]!.text).toContain('Use when');
  });

  test('any of the usual trigger openings satisfies it', () => {
    for (const description of [
      'Use this skill when the user wants a release.',
      'Use for database migrations.',
      'Whenever a release is requested.',
      'Covers releases, for when someone asks to ship.',
    ]) {
      expect(tones({ description })).toEqual([]);
    }
  });

  test('a hidden skill whose description reads like a trigger is told the wording can go', () => {
    const found = texts({
      invocable: false,
      description: 'Use when preparing release notes and GitHub releases.',
    });
    expect(found.map((check) => check.text)).toContain(
      'The model does not list this skill, so the description only helps you. A one-line summary is enough; the trigger wording can go.',
    );
    expect(found.every((check) => check.tone === 'info')).toBe(true);
  });

  test('a hidden skill with a plain summary is quiet about wording', () => {
    expect(texts({ invocable: false, description: 'Release notes and GitHub releases.' })).toEqual([
      { tone: 'info', text: 'The model does not list this skill. Load it yourself with @git-release.' },
    ]);
  });

  test('pinned by metadata, the trigger check does not apply', () => {
    const found = texts({ pinnedOff: true, invocable: false, description: 'Release notes.' });
    expect(found.some((check) => check.text.includes('when to use'))).toBe(false);
  });
});

describe('invocation', () => {
  test('hidden by the switch says how to load it', () => {
    const found = texts({ invocable: false, description: 'Release notes and GitHub releases.' });
    expect(found).toEqual([{ tone: 'info', text: 'The model does not list this skill. Load it yourself with @git-release.' }]);
  });

  test('pinned by metadata wins over the switch in the text', () => {
    const found = texts({ invocable: false, pinnedOff: true, description: 'Release notes.' });
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toContain('wins over the switch');
  });
});
