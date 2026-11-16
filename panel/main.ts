import { connectHost, HostRequestError } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountSearchField,
  mountSelect,
  mountSpinner,
  mountSwitch,
  mountTabs,
  mountTextField,
} from '@openchamber/sdk/ui';
import { checkSkill } from './checks';
import {
  parseSkillFile,
  rawLines,
  readField,
  untouchedKeys,
  writeSkillFile,
  type SkillFile,
} from './frontmatter';
import {
  autoinvokeOff,
  findSkills,
  idOf,
  isUsableId,
  markShadowed,
  sourceById,
  SOURCES,
  type Found,
  type Scope,
  type SkillForm,
  type SourceId,
} from './sources';

type Skill = {
  scope: Scope;
  source: SourceId;
  /** The path under the source root, in segments; the service rebuilds the path from it. */
  segments: string[];
  /** The ID OpenCode loads it by: the path, never the frontmatter `name`. */
  id: string;
  /** The markdown file the panel reads and writes. */
  path: string;
  /** The skill's own folder, for a folder skill; what deleting removes. */
  dir: string | null;
  form: SkillForm;
  file: SkillFile;
  /** The frontmatter `name`, or the ID when it has none. */
  name: string;
  description: string;
  /** False when `disable-model-invocation: true` is set. */
  invocable: boolean;
  /** `metadata.opencode/autoinvoke: false` wins over the switch, so the switch is left alone. */
  pinnedOff: boolean;
  /** A later source defines this ID too, so OpenCode loads that one instead. */
  shadowed: boolean;
};

type Draft = {
  id: string;
  name: string;
  description: string;
  body: string;
  form: SkillForm;
  source: SourceId;
};

/** Frontmatter keys this panel owns. Everything else is carried through. */
const OWNED = ['name', 'description', 'disable-model-invocation'];

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root')!;

let directory: string | null = null;
let scope: Scope = 'global';
let query = '';
let loading = false;
let loadError: string | null = null;
let skills: Skill[] = [];
/** Source roots that exist for this scope, so New can offer them. */
let roots: SourceId[] = [];
let editing: {
  skill: Skill | null;
  draft: Draft;
  error: string | null;
  /** Supporting files beside a SKILL.md; null until they are read. */
  extras: string[] | null;
} | null = null;
let started = false;

const ARROW_LEFT = 'M7.828 11H20v2H7.828l5.364 5.364-1.414 1.414L4 12l7.778-7.778 1.414 1.414z';

const iconSvg = (path: string, size = 14): SVGSVGElement => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
};

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const failure = (error: unknown): string => {
  if (error instanceof HostRequestError) {
    if (error.code === 'NOT_GRANTED') return 'OpenChamber has not granted file access to this extension yet.';
    if (error.code === 'NO_DIRECTORY') return 'Open a project first.';
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
};

// ------------------------------------------------------------------ reading

const listDir = async (path: string): Promise<{ name: string; kind: string }[]> =>
  (await host.listDir(path)).entries;

/**
 * Run `work` over everything, a few at a time. A global skills folder can hold
 * a hundred SKILL.md files, and the host answers one request per message, so
 * asking for all of them at once only makes the first row appear later.
 */
const inBatches = async <In, Out>(
  items: In[],
  limit: number,
  work: (item: In) => Promise<Out>,
): Promise<Out[]> => {
  const out: Out[] = [];
  for (let start = 0; start < items.length; start += limit) {
    out.push(...(await Promise.all(items.slice(start, start + limit).map(work))));
  }
  return out;
};

const toSkill = (
  target: Scope,
  source: SourceId,
  found: Found,
  text: string,
): Omit<Skill, 'shadowed'> => {
  const file = parseSkillFile(text);
  const id = idOf(found.segments);
  const pinnedOff = autoinvokeOff(rawLines(file, 'metadata'));
  return {
    scope: target,
    source,
    segments: found.segments,
    id,
    path: found.path,
    dir: found.dir,
    form: found.form,
    file,
    name: readField(file, 'name') || id,
    description: readField(file, 'description') ?? '',
    invocable: !pinnedOff && (readField(file, 'disable-model-invocation') ?? 'false').trim() !== 'true',
    pinnedOff,
  };
};

const readSkills = async (target: Scope): Promise<{ skills: Skill[]; roots: SourceId[] }> => {
  const present: SourceId[] = [];
  // In registration order, lowest precedence first: markShadowed depends on it.
  const ordered: Omit<Skill, 'shadowed'>[] = [];
  /** A refusal, kept in case every folder is refused: then it is the answer. */
  let refused: unknown = null;

  for (const source of SOURCES) {
    const dir = source.dir[target];
    try {
      const info = await host.stat(dir);
      if (info.kind !== 'directory') continue;
    } catch (error) {
      // A folder that is missing simply has no skills; one the host refuses to
      // look at is worth reporting when no folder could be read at all.
      const code = error instanceof HostRequestError ? error.code : '';
      if (code === 'NOT_GRANTED' || code === 'DENIED' || code === 'NO_DIRECTORY') refused = error;
      continue;
    }
    present.push(source.id);

    const found = await findSkills(dir, listDir);
    const read = await inBatches(found, 8, async (entry) => {
      try {
        const { content } = await host.readFile(entry.path);
        return toSkill(target, source.id, entry, content);
      } catch {
        return null; // unreadable: leave it out rather than fail the whole list
      }
    });
    for (const skill of read) if (skill) ordered.push(skill);
  }

  if (present.length === 0 && refused) throw refused;

  const marked = markShadowed(ordered);
  marked.sort((left, right) => left.name.localeCompare(right.name));
  return { skills: marked, roots: present };
};

const load = async (): Promise<void> => {
  if (scope === 'project' && !directory) {
    skills = [];
    roots = [];
    loadError = null;
    render();
    return;
  }
  loading = true;
  loadError = null;
  render();
  try {
    const read = await readSkills(scope);
    skills = read.skills;
    roots = read.roots;
  } catch (error) {
    skills = [];
    roots = [];
    loadError = failure(error);
  }
  loading = false;
  render();
};

/** The supporting files beside a SKILL.md, for the editor's note. */
const readExtras = async (skill: Skill): Promise<string[]> => {
  if (!skill.dir) return [];
  try {
    const { entries } = await host.listDir(skill.dir);
    return entries
      .filter((entry) => entry.name !== 'SKILL.md' && !entry.name.startsWith('.'))
      .map((entry) => (entry.kind === 'directory' ? `${entry.name}/` : entry.name));
  } catch {
    return [];
  }
};

// ------------------------------------------------------------------ writing

/**
 * Hide a skill from the model, or show it again, from the list. `paint` moves
 * the row to that state at once and moves it back if the write fails, so the
 * list is never rebuilt and keeps its scroll position, the search text and the
 * focused switch.
 */
const setInvocable = async (
  skill: Skill,
  invocable: boolean,
  paint: (invocable: boolean) => void,
): Promise<void> => {
  const text = writeSkillFile(
    skill.file,
    { 'disable-model-invocation': invocable ? null : 'true' },
    skill.file.body,
  );
  paint(invocable);
  try {
    await host.writeFile(skill.path, text);
  } catch (error) {
    paint(!invocable);
    await host.toast({ kind: 'error', message: failure(error) });
    return;
  }
  skill.file = parseSkillFile(text);
  skill.invocable = invocable;
  await host.toast({
    kind: 'success',
    message: invocable
      ? `${skill.name} is listed to the model again. New sessions pick it up.`
      : `${skill.name} is hidden from the model. You can still load it with @${skill.id}.`,
  });
};

/**
 * Delete a skill. Only the service can remove a file or a folder, and it
 * builds the path from the scope, source and name segments itself, so this
 * call carries no path.
 */
const remove = async (skill: Skill): Promise<void> => {
  const report = async (message: string): Promise<void> => {
    if (editing) {
      editing.error = message;
      render();
    } else {
      await host.toast({ kind: 'error', message });
    }
  };

  let answer: { status: number; body: string };
  try {
    answer = await host.serviceRequest({
      method: 'POST',
      path: '/delete',
      body: JSON.stringify({
        scope: skill.scope,
        source: skill.source,
        segments: skill.segments,
        form: skill.form,
        directory: skill.scope === 'project' ? directory : undefined,
      }),
    });
  } catch (error) {
    const code = error instanceof HostRequestError ? error.code : '';
    await report(
      code === 'NO_SERVICE'
        ? 'Deleting needs this extension’s local helper. Approve it in Settings → Extensions.'
        : code === 'SERVICE_FAILED'
          ? 'The helper could not start, so nothing was deleted.'
          : failure(error),
    );
    return;
  }

  if (answer.status !== 200) {
    let message = `The helper answered ${answer.status}.`;
    try {
      const body: unknown = JSON.parse(answer.body || '{}');
      const said = body && typeof body === 'object' ? (body as Record<string, unknown>).message : null;
      if (typeof said === 'string' && said !== '') message = said;
    } catch {
      // keep the status line
    }
    await report(message);
    return;
  }

  editing = null;
  await host.toast({ kind: 'success', message: `Deleted ${skill.id}.` });
  await load();
};

const emptyDraft = (): Draft => ({
  id: '',
  name: '',
  description: '',
  body: '',
  form: 'dir',
  source: roots.includes('opencode') ? 'opencode' : (roots[0] ?? 'opencode'),
});

const draftOf = (skill: Skill): Draft => ({
  id: skill.id,
  name: readField(skill.file, 'name') ?? '',
  description: skill.description,
  body: skill.file.body.trim(),
  form: skill.form,
  source: skill.source,
});

/** What the checks need to know about the skill being edited, now. */
const checkInputOf = (skill: Skill | null, draft: Draft) => {
  const others = skills.filter((other) => other.id === draft.id.trim() && other !== skill);
  const winner = skill?.shadowed
    ? (skills.find((other) => other.id === skill.id && !other.shadowed) ?? null)
    : null;
  return {
    id: skill ? skill.id : draft.id.trim(),
    name: draft.name,
    description: draft.description,
    body: draft.body,
    invocable: skill ? skill.invocable : true,
    pinnedOff: skill?.pinnedOff ?? false,
    isNew: skill === null,
    hadFrontmatter: skill?.file.hadFrontmatter ?? true,
    sameIdElsewhere: others.map(sourceLabel),
    winner: winner ? sourceLabel(winner) : null,
  };
};

/** The folder a skill was read from, as the user would type it. */
const sourceLabel = (skill: Skill): string => sourceById(skill.source).dir[skill.scope];

const openEditor = (skill: Skill | null): void => {
  editing = { skill, draft: skill ? draftOf(skill) : emptyDraft(), error: null, extras: null };
  render();
  if (skill?.dir) {
    const opened = editing;
    void readExtras(skill).then((names) => {
      if (editing !== opened) return; // the user moved on
      opened.extras = names;
      render();
    });
  }
};

const save = async (): Promise<void> => {
  if (!editing) return;
  const { skill, draft } = editing;
  const id = draft.id.trim();

  if (!skill) {
    if (!isUsableId(id)) {
      editing.error = 'An ID uses lowercase letters, numbers and dashes, such as git-release.';
      render();
      return;
    }
    if (skills.some((other) => other.id === id)) {
      editing.error = `${id} is already a skill here. Open it instead, or pick another ID.`;
      render();
      return;
    }
  }
  if (draft.description.trim() === '') {
    editing.error = 'Write a description: without one OpenCode never offers the skill to a model.';
    render();
    return;
  }

  const updates: Record<string, string | null> = {
    name: draft.name.trim() === '' ? null : draft.name.trim(),
    description: draft.description.trim(),
  };

  const base: SkillFile = skill ? skill.file : { entries: [], hadFrontmatter: false, body: '' };
  const text = writeSkillFile(base, updates, draft.body);
  const dir = sourceById(draft.source).dir[scope];
  const path = skill ? skill.path : draft.form === 'dir' ? `${dir}/${id}/SKILL.md` : `${dir}/${id}.md`;

  if (!skill) {
    try {
      const info = await host.stat(path);
      if (info.kind !== 'missing') {
        editing.error = `${path} already exists.`;
        render();
        return;
      }
    } catch (error) {
      editing.error = failure(error);
      render();
      return;
    }
  }

  try {
    await host.writeFile(path, text);
  } catch (error) {
    editing.error = failure(error);
    render();
    return;
  }
  editing = null;
  await host.toast({
    kind: 'success',
    message: skill ? `Saved ${id}. New sessions pick it up.` : `Created ${id}. New sessions pick it up.`,
  });
  await load();
};

// ---------------------------------------------------------------- list view

const paintRows = (into: HTMLElement): void => {
  into.replaceChildren();

  if (loading) {
    mountSpinner(into, { label: 'Reading skill files…' });
    return;
  }
  if (loadError) {
    mountBanner(into, { tone: 'error', title: 'Could not read the skills', body: loadError });
    return;
  }
  if (scope === 'project' && !directory) {
    mountEmpty(into, {
      title: 'No project open',
      body: 'Project skills live in .opencode/skills of the open project.',
    });
    return;
  }

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? skills.filter(
        (skill) =>
          skill.name.toLowerCase().includes(needle) ||
          skill.id.toLowerCase().includes(needle) ||
          skill.description.toLowerCase().includes(needle),
      )
    : skills;

  if (shown.length === 0) {
    mountEmpty(into, {
      title: skills.length === 0 ? 'No skills yet' : 'Nothing matches',
      body:
        skills.length === 0
          ? scope === 'global'
            ? 'A skill is a folder with a SKILL.md in ~/.config/opencode/skills.'
            : 'A skill is a folder with a SKILL.md in .opencode/skills of this project.'
          : 'Clear the search to see every skill.',
      action:
        skills.length === 0
          ? { label: 'New skill', onClick: () => openEditor(null) }
          : undefined,
    });
    return;
  }

  const rows = el('div', 'rows');
  for (const skill of shown) {
    const row = el('div', 'row');
    row.dataset.off = String(!skill.invocable);

    const main = el('button', 'row-main');
    main.type = 'button';
    const top = el('div', 'row-top');
    top.append(el('span', 'row-name', skill.name));
    const badge = sourceById(skill.source).badge;
    if (badge) mountBadge(top, { label: badge, tone: 'neutral' });
    if (skill.shadowed) mountBadge(top, { label: 'overridden', tone: 'warning' });
    if (skill.description === '') mountBadge(top, { label: 'no description', tone: 'warning' });
    if (skill.pinnedOff) mountBadge(top, { label: 'hidden in metadata', tone: 'neutral' });
    main.append(top);
    if (skill.description) main.append(el('div', 'row-desc', skill.description));
    main.append(
      el(
        'div',
        'row-id',
        skill.form === 'dir' ? `${skill.segments.join('/')}/SKILL.md` : `${skill.id}.md`,
      ),
    );
    main.addEventListener('click', () => openEditor(skill));

    const side = el('div', 'row-side');
    const toggle = mountSwitch(side, {
      label: skill.invocable ? 'On' : 'Off',
      checked: skill.invocable,
      disabled: skill.pinnedOff,
      onChange: (checked) => {
        void setInvocable(skill, checked, paint);
      },
    });
    const paint = (invocable: boolean): void => {
      row.dataset.off = String(!invocable);
      toggle.update({ label: invocable ? 'On' : 'Off', checked: invocable });
    };

    row.append(main, side);
    rows.append(row);
  }
  into.append(rows);
};

const renderList = (): void => {
  const bar = el('div', 'bar');
  root.append(bar);

  const tabsHolder = el('div');
  bar.append(tabsHolder);
  const tabs = mountTabs(tabsHolder, {
    items: [
      { id: 'global', label: 'Global' },
      { id: 'project', label: 'Project' },
    ],
    activeId: scope,
    onChange: (next) => {
      scope = next as Scope;
      tabs.update({ activeId: scope });
      void load();
    },
  });

  bar.append(el('div', 'grow'));
  const newHolder = el('div');
  bar.append(newHolder);
  mountButton(newHolder, {
    label: 'New',
    size: 'sm',
    disabled: scope === 'project' && !directory,
    onClick: () => openEditor(null),
  });

  const searchHolder = el('div');
  root.append(searchHolder);
  const rowsHolder = el('div');
  root.append(rowsHolder);

  mountSearchField(searchHolder, {
    value: query,
    placeholder: 'Search skills',
    onChange: (next) => {
      query = next;
      paintRows(rowsHolder); // keeps the field focused while typing
    },
  });

  paintRows(rowsHolder);

  root.append(
    el(
      'div',
      'muted',
      scope === 'global'
        ? '~/.config/opencode/skills, ~/.claude/skills and ~/.agents/skills · Off writes disable-model-invocation: true, so the model stops listing the skill; you can still load it with @id.'
        : '.opencode/skills, .claude/skills and .agents/skills in this project.',
    ),
  );
};

// -------------------------------------------------------------- editor view

const renderEditor = (): void => {
  const current = editing!;
  const { skill, draft } = current;
  const newDir = sourceById(draft.source).dir[scope];

  // The checks are repainted on every keystroke, in place, so the field keeps focus.
  const checksHolder = el('div', 'checks');
  const paintChecks = (): void => {
    checksHolder.replaceChildren();
    for (const check of checkSkill(checkInputOf(skill, draft))) {
      const holder = el('div');
      checksHolder.append(holder);
      mountBanner(holder, { tone: check.tone, title: check.text });
    }
  };

  const bar = el('div', 'bar');
  const backHolder = el('div');
  bar.append(backHolder);
  mountButton(backHolder, {
    label: 'Back',
    variant: 'ghost',
    size: 'sm',
    onClick: () => {
      editing = null;
      render();
    },
  });
  // The kit's button only repaints its label span, so an icon prepended here stays.
  backHolder.querySelector('button')?.prepend(iconSvg(ARROW_LEFT));
  bar.append(el('div', 'grow'));
  bar.append(
    el(
      'div',
      'muted mono',
      skill
        ? skill.path
        : `new in ${newDir}/${draft.id.trim() === '' ? '…' : draft.id.trim()}${draft.form === 'dir' ? '/SKILL.md' : '.md'}`,
    ),
  );
  root.append(bar);

  if (skill?.shadowed) {
    const banner = el('div');
    root.append(banner);
    mountBanner(banner, {
      tone: 'warning',
      title: `Another ${skill.id} wins`,
      body: 'A source with higher precedence defines this ID too, so OpenCode loads that file instead of this one.',
    });
  }

  const fields = el('div', 'fields');
  root.append(fields);

  if (!skill) {
    const idHolder = el('div');
    fields.append(idHolder);
    mountTextField(idHolder, {
      label: 'ID',
      value: draft.id,
      mono: true,
      placeholder: 'git-release',
      helper: 'The folder name, and how an agent loads it: @git-release.',
      onChange: (value) => {
        draft.id = value;
        paintChecks();
      },
    });

    const pair = el('div', 'pair');
    fields.append(pair);

    const formHolder = el('div');
    pair.append(formHolder);
    const formSelect = mountSelect(formHolder, {
      label: 'Shape',
      value: draft.form,
      options: [
        { id: 'dir', label: 'Folder with SKILL.md', hint: 'can hold scripts' },
        { id: 'file', label: 'Single markdown file', hint: 'id.md' },
      ],
      onChange: (value) => {
        draft.form = value === 'file' ? 'file' : 'dir';
        formSelect.update({ value });
      },
    });

    const sourceHolder = el('div');
    pair.append(sourceHolder);
    const sourceOptions = SOURCES.filter(
      (source) => roots.includes(source.id) || source.id === 'opencode',
    ).map((source) => ({
      id: source.id,
      label: source.dir[scope],
      hint: source.id === 'opencode' ? "OpenCode's own" : 'compatibility',
    }));
    const sourceSelect = mountSelect(sourceHolder, {
      label: 'Folder',
      value: draft.source,
      options: sourceOptions,
      disabled: sourceOptions.length < 2,
      onChange: (value) => {
        draft.source = value as SourceId;
        sourceSelect.update({ value });
        render(); // the bar shows the path it will write
      },
    });
  }

  const nameHolder = el('div');
  fields.append(nameHolder);
  mountTextField(nameHolder, {
    label: 'Name',
    value: draft.name,
    placeholder: skill ? skill.id : 'Git Release',
    onChange: (value) => {
      draft.name = value;
      paintChecks();
    },
  });

  const descHolder = el('div');
  fields.append(descHolder);
  mountTextField(descHolder, {
    label: 'Description',
    value: draft.description,
    multiline: true,
    rows: 5,
    placeholder: 'Prepare release notes, version bumps and GitHub releases.',
    onChange: (value) => {
      draft.description = value;
      paintChecks();
    },
  });

  const bodyHolder = el('div');
  fields.append(bodyHolder);
  mountTextField(bodyHolder, {
    label: 'Instructions',
    value: draft.body,
    multiline: true,
    rows: 14,
    mono: true,
    placeholder: 'The steps to follow, what to read first, what not to do.',
    helper: 'What the agent gets when it loads the skill. Paths inside are relative to the skill folder.',
    onChange: (value) => {
      draft.body = value;
      paintChecks();
    },
  });

  if (skill) {
    const kept = untouchedKeys(skill.file, OWNED);
    if (kept.length > 0) {
      fields.append(el('div', 'muted', `Kept as written: ${kept.join(', ')}.`));
    }
    if (current.extras && current.extras.length > 0) {
      const names = current.extras.slice(0, 8).join(', ');
      const rest = current.extras.length - 8;
      fields.append(
        el('div', 'muted', `Beside SKILL.md: ${names}${rest > 0 ? ` and ${rest} more` : ''}.`),
      );
    }
  }

  fields.append(checksHolder);
  paintChecks();

  // The error sits right above the buttons, where the user just clicked, not at
  // the top of a long form they have scrolled past.
  if (current.error) {
    const banner = el('div');
    root.append(banner);
    mountBanner(banner, { tone: 'error', title: current.error });
  }

  const foot = el('div', 'foot');
  root.append(foot);
  const saveHolder = el('div');
  foot.append(saveHolder);
  mountButton(saveHolder, {
    label: skill ? 'Save' : 'Create skill',
    onClick: () => {
      void save();
    },
  });
  const cancelHolder = el('div');
  foot.append(cancelHolder);
  mountButton(cancelHolder, {
    label: 'Cancel',
    variant: 'ghost',
    onClick: () => {
      editing = null;
      render();
    },
  });
  foot.append(el('div', 'grow'));

  if (skill) {
    // Its own row under the other buttons, so a long confirmation never pushes
    // the button out of the narrow rail.
    const target = skill.form === 'dir' ? `${skill.id}/ and its files` : `${skill.id}.md`;
    const removeRow = el('div', 'foot');
    root.append(removeRow);
    const removeHolder = el('div');
    removeRow.append(removeHolder);
    const hint = el('div', 'muted', `Deletes ${target}.`);
    removeRow.append(hint);
    let armed = false;
    const deleteButton = mountButton(removeHolder, {
      label: 'Delete',
      variant: 'destructive',
      size: 'sm',
      onClick: () => {
        if (!armed) {
          // First click arms it, the second one deletes: no dialog to mis-click.
          armed = true;
          deleteButton.update({ label: 'Yes, delete' });
          hint.textContent = `Click “Yes, delete” to remove ${target}.`;
          return;
        }
        deleteButton.update({ label: 'Deleting…', loading: true });
        hint.textContent = '';
        void remove(skill);
      },
    });
  }
};

const render = (): void => {
  root.replaceChildren();
  if (editing) renderEditor();
  else renderList();
};

host.onDirectory((next) => {
  const changed = next !== directory;
  directory = next;
  if (!started) return;
  if (changed && scope === 'project') void load();
  else if (changed) render();
});

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  directory = context.directory;
  if (started) return;
  started = true;
  void load();
});
