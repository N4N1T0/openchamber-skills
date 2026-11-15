# Skills — an OpenChamber extension

A panel on OpenChamber's rail that lists your OpenCode skills and lets you hide
them from the model, show them again, edit them and create new ones. Your
skills stay plain `SKILL.md` files; this is a front end for them, not another
place to keep them.

The sister extension for agents is
[openchamber-agents](https://github.com/N4N1T0/openchamber-agents).

## Install

Requirements: OpenChamber 2.7.2 or newer, and OpenCode skills as markdown files.

1. Click **Install in OpenChamber**, or open OpenChamber's Settings → Extensions
   and add the repository URL `https://github.com/N4N1T0/openchamber-skills`.

   [**Install in OpenChamber**](openchamber://extensions/install?url=https%3A%2F%2Fgithub.com%2FN4N1T0%2Fopenchamber-skills)

2. Approve what the extension asks for. File access (your global skill folders
   and the open project's `.opencode/skills`) is granted there. If the panel
   says OpenChamber has not granted file access, grant it in Settings →
   Extensions.
3. Deleting needs the extension's local service, approved in the same place.
   Until you approve it, delete says so and everything else keeps working. See
   [Why deleting needs a service](#why-deleting-needs-a-service).
4. Open the **Skills** icon on the rail. The **Global** tab lists
   `~/.config/opencode/skills`; the **Project** tab needs a project open.

## What it does

- **Lists every skill that is a file**, under two tabs: **Global**
  (`~/.config/opencode/skills`, plus the compatibility folders
  `~/.claude/skills` and `~/.agents/skills`) and **Project** (`.opencode/skills`,
  `.claude/skills` and `.agents/skills` of the project you have open). Name,
  description and path on each row, and a badge on a row that comes from a
  compatibility folder.
- **A switch on each row** hides a skill from the model or lists it again. Off
  writes `disable-model-invocation: true` into the frontmatter, and switching
  back on removes the key again. The skill stays registered either way: you can
  still load it yourself with `@skill-id`. The row changes immediately and only
  moves back if the write fails, so the list keeps its scroll position and your
  search text.
- **Click a row to edit**: the ID (new skills only), the display name, the
  description, a switch for whether the model lists the skill, and the
  instructions body. Changes are saved with **Save**; the switch in the editor
  and the one on the row are the same setting.
- **Checks** sit under the fields and update as you type. They flag what would
  make a skill misbehave, and say what to do about it:

  | Check | Tone | When |
  |---|---|---|
  | No description | error | OpenCode never offers a skill without one |
  | Description over 500 characters | warning | it is sent to the model at every step |
  | Overridden by a folder of higher precedence | warning | OpenCode loads the other file |
  | No instructions | warning | a model that loads it gets nothing to follow |
  | No frontmatter | warning | the description cannot be read |
  | Listed skill whose description does not say when to use it | warning | the model decides from the description alone |
  | Hidden skill whose description reads as a trigger | info | only you read it, so a one-line summary is enough |
  | ID that is not lowercase kebab-case | info | other tools may not accept it |
  | Name that differs from the ID | info | OpenCode loads the skill by its ID |
  | Hidden by the switch, or pinned by `metadata` | info | says how to load it with `@id` |

  The 500-character limit is this panel's choice, not OpenCode's: OpenCode's
  docs say it does not enforce a maximum description length.
- **New** creates a skill in the folder you pick — a folder with a `SKILL.md`,
  or a single `<id>.md` — after checking the ID and that nothing is there yet.
- **Delete** sits in the editor, takes two clicks, and for a folder skill
  removes the folder with its scripts and references.
- **Search** filters by name, ID or description.

Changes land in new sessions. A session that is already running keeps the
skills it started with.

### What the badges mean

| Badge | Meaning |
|---|---|
| `.claude`, `.agents` | The skill comes from a compatibility folder, not from OpenCode's own |
| `overridden` | A folder with higher precedence defines the same ID, so OpenCode loads that one instead |
| `no description` | OpenCode never offers this skill to a model; give it a description |
| `hidden in metadata` | Its `metadata` block sets `opencode/autoinvoke: false`, which wins over the switch |

## How skills are found

The same rules OpenCode uses, so the panel lists what OpenCode loads:

- A markdown file at the root of a skills folder is a skill (`review.md` → `review`).
- A folder holding a `SKILL.md` is one skill, and is not searched any deeper.
- Any other folder is a grouping folder, searched up to six levels down, so
  `teams/release/SKILL.md` is the skill `release`.
- Hidden entries and `node_modules` are skipped.
- The ID is the path, never the frontmatter `name`. When two folders hold the
  same ID, the one later in OpenCode's order wins: `.claude/skills`,
  `.agents/skills`, `~/.config/opencode/skills`, then the project's
  `.opencode/skills`. The panel marks the losers `overridden`.

Skills added with the `skills` array in `opencode.json`, HTTP catalogs and
OpenCode's built-in skills are not files in these folders, so they are not
listed.

## Saving never reformats the rest of your file

The frontmatter writer only replaces the keys the panel edits (`name`,
`description` and `disable-model-invocation`). Every other line is carried
through exactly as written — a `metadata:` block, `allowed-tools`, `license`,
`compatibility`, comments, block scalars, key order. The editor shows a line
like *Kept as written: metadata, license* so you can see what it left alone.
`bun test` covers this with fixtures taken from real skill files.

A key the panel does edit is rewritten in a single-quoted form, so a
description with a colon or an apostrophe in it stays valid YAML.

## What it asks for, and why

| It asks for | For |
|---|---|
| Project files | Reading and writing `.opencode/skills`, `.claude/skills` and `.agents/skills` of the open project |
| `~/.config/opencode/skills` | Your global OpenCode skills |
| `~/.claude/skills`, `~/.agents/skills` | The compatibility folders OpenCode also reads |
| A local service | Deleting. See below |

The extension declares no network origins, so nothing it reads leaves your
machine.

### Why deleting needs a service

The extension file API can read, write, list and stat — it cannot delete. A
local service is the only part of an extension that can, and OpenChamber says
plainly in the approval dialog that a service runs with your full access.

So the service takes no path from the panel. It takes a scope (`global` or
`project`), one of the three skill folders, the skill's shape (`dir` or `file`)
and its name segments, and builds the path itself. Each segment must match
`^[A-Za-z0-9][A-Za-z0-9._-]*$`, so it can hold no slash, no `..` and no leading
dot, there are at most six of them, and the only paths the service can reach
are:

```
<home>/{.config/opencode,.claude,.agents}/skills/<segments…>
<project>/{.opencode,.claude,.agents}/skills/<segments…>
```

Before deleting it uses `lstat`, not `stat`: a symlink is neither a regular
file nor a folder, so one that points somewhere else is refused instead of
followed. A folder is deleted only when it really holds a `SKILL.md`, and then
with the files beside it. A single file is deleted only when it is a regular
`.md` at the root of its folder. Anything else answers 400 and touches nothing.
The service does nothing else — no clock, no session access, no network — and
stops on its own after ten quiet minutes.

Until you approve it, deleting says so and the rest of the panel works.

## Limits

- OpenCode's built-in skills are not files, so they are not listed. You can
  still shadow one by creating a skill with that ID.
- Conflicts are checked only against the skills in the folders the panel
  reads. Skills declared in `opencode.json` (`skills`), HTTP catalogs and
  permissions that hide a skill are not visible to the panel, so the checks
  cannot warn about them.
- The switch writes `disable-model-invocation`. A skill whose `metadata` block
  sets `opencode/autoinvoke: false` is hidden by that key, which wins, so the
  panel reports it and leaves both as written.
- Permissions (`{ "action": "skill", … }` in `opencode.json`) also decide which
  skills a model sees. This panel edits files, not permissions.
- VS Code and the phone load no extensions.

## Development

Requires [Bun](https://bun.sh) (CI uses the latest).

```sh
bun install
bun test
bunx tsc --noEmit
bunx openchamber-guest-bundle panel/main.ts panel/main.js
bunx openchamber-guest-bundle --node service/main.ts service/main.js
bunx openchamber-guest-check
```

The built `.js` files are committed, because installing an extension never
builds it. CI (`.github/workflows/check.yml`) runs the tests, the type check,
rebuilds both bundles and fails if they differ from the sources, then packages
the extension, so a stale bundle cannot reach anyone. Rebuild and commit
`panel/main.js` and `service/main.js` after every change to their sources.

| Path | What it is |
|---|---|
| `panel/main.ts` | The panel: list, editor, file reads and writes |
| `panel/frontmatter.ts` | Reading and rewriting skill frontmatter without disturbing it |
| `panel/sources.ts` | Where skills live, how they are found, IDs and precedence |
| `panel/checks.ts` | The checks shown while editing a skill |
| `panel/checks.test.ts` | Tests for each check |
| `panel/index.html` | The panel's page and its styles |
| `panel/frontmatter.test.ts` | Tests for the frontmatter round trip |
| `panel/sources.test.ts` | Tests for discovery, IDs and precedence |
| `service/main.ts` | The delete service |
| `package.json` | The extension manifest: id, name, icon, permissions and filesystem scope |
| `assets/skills.svg` | The rail icon |

## Licence

MIT. See [LICENSE](LICENSE).
