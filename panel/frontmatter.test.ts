import { describe, expect, test } from 'bun:test';
import {
  parseSkillFile,
  rawLines,
  readField,
  untouchedKeys,
  writeSkillFile,
} from './frontmatter';

const OWNED = ['name', 'description', 'disable-model-invocation'];

/** A real SKILL.md: a folded description, a licence line, a long body. */
const FOLDED = `---
name: academy-guide
description: >
  Stop and check this skill before finishing any reply about how to use a
  product. Only recommend on a strong match; never invent content.
license: Complete terms in LICENSE.txt
---

# Academy guide

Recommend a course.
`;

/** The shapes the panel must not disturb: a metadata block, a tools list, comments. */
const META = `---
# loaded by hand only
name: Git Release
description: Prepare release notes, version bumps and GitHub releases
metadata:
  opencode/autoinvoke: false
  team: platform
allowed-tools:
  - Read
  - Bash
compatibility: '>=1.0'
---

## Workflow

1. Read references/release-policy.md.
`;

describe('reading', () => {
  test('a folded block scalar becomes one line', () => {
    const file = parseSkillFile(FOLDED);
    expect(readField(file, 'name')).toBe('academy-guide');
    expect(readField(file, 'description')).toBe(
      'Stop and check this skill before finishing any reply about how to use a product. Only recommend on a strong match; never invent content.',
    );
    expect(file.body.trim().startsWith('# Academy guide')).toBe(true);
  });

  test('a plain scalar and a quoted one read the same way', () => {
    const file = parseSkillFile(META);
    expect(readField(file, 'name')).toBe('Git Release');
    expect(readField(file, 'description')).toBe('Prepare release notes, version bumps and GitHub releases');
    expect(readField(file, 'compatibility')).toBe('>=1.0');
  });

  test('nested blocks are reported as keys the panel does not own', () => {
    expect(untouchedKeys(parseSkillFile(FOLDED), OWNED)).toEqual(['license']);
    expect(untouchedKeys(parseSkillFile(META), OWNED)).toEqual([
      'metadata',
      'allowed-tools',
      'compatibility',
    ]);
  });

  test('the metadata block is available as written', () => {
    expect(rawLines(parseSkillFile(META), 'metadata')).toEqual([
      'metadata:',
      '  opencode/autoinvoke: false',
      '  team: platform',
    ]);
    expect(rawLines(parseSkillFile(FOLDED), 'metadata')).toEqual([]);
  });

  test('a file without frontmatter is all body', () => {
    const file = parseSkillFile('Just instructions.\n');
    expect(file.hadFrontmatter).toBe(false);
    expect(file.body.trim()).toBe('Just instructions.');
    expect(readField(file, 'description')).toBe(null);
  });

  test('an unterminated frontmatter marker is not frontmatter', () => {
    const file = parseSkillFile('---\ndescription: x\n');
    expect(file.hadFrontmatter).toBe(false);
    expect(readField(file, 'description')).toBe(null);
  });
});

describe('writing', () => {
  for (const [name, original] of [
    ['folded', FOLDED],
    ['metadata', META],
  ] as const) {
    test(`${name}: rewriting with no change keeps the file`, () => {
      const file = parseSkillFile(original);
      expect(writeSkillFile(file, {}, file.body).trim()).toBe(original.trim());
    });

    test(`${name}: hidden and listed again returns to the same file`, () => {
      const file = parseSkillFile(original);
      const off = parseSkillFile(
        writeSkillFile(file, { 'disable-model-invocation': 'true' }, file.body),
      );
      expect(readField(off, 'disable-model-invocation')).toBe('true');
      const on = writeSkillFile(off, { 'disable-model-invocation': null }, off.body);
      expect(on.trim()).toBe(original.trim());
      expect(on).not.toContain('disable-model-invocation');
    });
  }

  test('hiding a skill leaves the metadata block, the comment and the list alone', () => {
    const file = parseSkillFile(META);
    const next = writeSkillFile(file, { 'disable-model-invocation': 'true' }, file.body);
    expect(next).toContain('# loaded by hand only');
    expect(next).toContain('metadata:\n  opencode/autoinvoke: false\n  team: platform');
    expect(next).toContain('allowed-tools:\n  - Read\n  - Bash');
    expect(next).toContain('disable-model-invocation: true');
    expect(parseSkillFile(next).body.trim().startsWith('## Workflow')).toBe(true);
  });

  test('editing the description leaves every other line alone', () => {
    const file = parseSkillFile(META);
    const next = writeSkillFile(file, { description: "Now with: a colon and 'quotes'." }, file.body);
    expect(next).toContain("description: 'Now with: a colon and ''quotes''.'");
    const reparsed = parseSkillFile(next);
    expect(readField(reparsed, 'description')).toBe("Now with: a colon and 'quotes'.");
    expect(readField(reparsed, 'name')).toBe('Git Release');
    expect(untouchedKeys(reparsed, OWNED)).toEqual(['metadata', 'allowed-tools', 'compatibility']);
  });

  test('replacing a folded scalar leaves no orphan continuation lines', () => {
    const file = parseSkillFile(FOLDED);
    const next = writeSkillFile(file, { description: 'Short now.' }, file.body);
    expect(next).not.toContain('never invent content');
    expect(next.split('\n').filter((line) => line.startsWith('description'))).toHaveLength(1);
    expect(next).toContain('license: Complete terms in LICENSE.txt');
  });

  test('removing the name drops the key', () => {
    const file = parseSkillFile(META);
    const next = writeSkillFile(file, { name: null }, file.body);
    expect(readField(parseSkillFile(next), 'name')).toBe(null);
    expect(next).toContain('description:');
  });

  test('a new skill is written with quoted text and the body it was given', () => {
    const fresh = writeSkillFile(
      { entries: [], hadFrontmatter: false, body: '' },
      { name: 'Git Release', description: 'Prepare a repository release.', 'disable-model-invocation': null },
      '## Workflow\n\n1. Summarize the changes.\n',
    );
    expect(fresh).toBe(
      "---\nname: 'Git Release'\ndescription: 'Prepare a repository release.'\n---\n\n## Workflow\n\n1. Summarize the changes.\n",
    );
  });

  test('a description with newlines becomes a block scalar and reads back', () => {
    const written = writeSkillFile(
      { entries: [], hadFrontmatter: false, body: '' },
      { description: 'first\nsecond' },
      '',
    );
    expect(written).toContain('description: |-');
    expect(readField(parseSkillFile(written), 'description')).toBe('first\nsecond');
  });

  test('CRLF input is written back with plain newlines', () => {
    const file = parseSkillFile('---\r\nname: x\r\n---\r\n\r\nBody.\r\n');
    expect(readField(file, 'name')).toBe('x');
    expect(writeSkillFile(file, {}, file.body)).not.toContain('\r');
  });
});
