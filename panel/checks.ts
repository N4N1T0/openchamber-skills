// Checks on one skill as it is being edited. Pure, so `bun test` can cover the
// rules without a host.
//
// What it can know: what is in this file, and which skills the panel has
// loaded from the folders it reads. What it cannot know: skills declared in
// `opencode.json` `skills`, HTTP catalogs, OpenCode's built-in skills, or
// whether OpenCode would reject a value. Those limits are said in the README,
// not guessed at here.

export type Tone = 'error' | 'warning' | 'info';
export type Check = { tone: Tone; text: string };

/**
 * A soft limit this panel picks, not one OpenCode enforces: OpenCode's docs say
 * it does not check description length. Every listed description is sent to
 * the model at each step, so a long one costs tokens in every session.
 */
export const DESCRIPTION_SOFT_LIMIT = 500;

export type CheckInput = {
  /** The ID as typed or as loaded. */
  id: string;
  /** The frontmatter `name`, or '' when none. */
  name: string;
  description: string;
  body: string;
  /** False when the switch hides the skill from the model. */
  invocable: boolean;
  /** `metadata.opencode/autoinvoke: false` decides, whatever the switch says. */
  pinnedOff: boolean;
  /** A new skill has no file yet. */
  isNew: boolean;
  /** For an existing file: whether it has a frontmatter block at all. */
  hadFrontmatter: boolean;
  /** Labels of the other loaded skills that use this ID, in precedence order. */
  sameIdElsewhere: string[];
  /** The label of the skill that wins for this ID when this one is shadowed. */
  winner: string | null;
};

/** The shape a portable ID has. OpenCode V2 does not enforce it. */
const PORTABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const checkSkill = (input: CheckInput): Check[] => {
  const out: Check[] = [];
  const description = input.description.trim();

  if (input.isNew && input.sameIdElsewhere.length > 0) {
    out.push({
      tone: 'error',
      text: `${input.id} is already a skill in ${input.sameIdElsewhere.join(', ')}. Pick another ID.`,
    });
  }

  if (!input.isNew && !input.hadFrontmatter) {
    out.push({
      tone: 'warning',
      text: 'This file has no frontmatter, so OpenCode cannot read its description and the model never sees it. Saving adds one.',
    });
  }

  if (description === '') {
    out.push({
      tone: 'error',
      text: 'No description: OpenCode never offers a skill without one to the model.',
    });
  } else if (description.length > DESCRIPTION_SOFT_LIMIT) {
    out.push({
      tone: 'warning',
      text: `The description is ${description.length} characters. It goes to the model at every step, so keep it to when to use the skill (about ${DESCRIPTION_SOFT_LIMIT} at most).`,
    });
  }

  if (input.id !== '' && !PORTABLE_ID.test(input.id)) {
    out.push({
      tone: 'info',
      text: `${input.id} is not lowercase kebab-case. Other tools that read skills may not accept it.`,
    });
  }

  if (input.name.trim() !== '' && input.name.trim() !== input.id) {
    out.push({
      tone: 'info',
      text: `The name "${input.name.trim()}" is only a label. OpenCode loads the skill as @${input.id}.`,
    });
  }

  if (input.body.trim() === '') {
    out.push({
      tone: 'warning',
      text: 'No instructions: a model that loads this skill gets nothing to follow.',
    });
  }

  if (!input.isNew && input.winner) {
    out.push({
      tone: 'warning',
      text: `${input.winner} defines ${input.id} too and has higher precedence, so OpenCode loads that one instead.`,
    });
  }

  if (input.pinnedOff) {
    out.push({
      tone: 'info',
      text: 'metadata sets opencode/autoinvoke: false, which wins over the switch, so the model never lists this skill.',
    });
  } else if (!input.invocable) {
    out.push({
      tone: 'info',
      text: `The model does not list this skill. Load it yourself with @${input.id}.`,
    });
  }

  return out;
};
