// The only thing this service exists for: removing a skill.
//
// The guest file API can read, write, list and stat, but not delete, and a
// service is the only place in an extension that can. It runs with the user's
// full access, so it never takes a path from the panel: it takes a scope, one
// of the three skill folders, and the skill's name segments, and builds the
// path itself.

import http from 'node:http';
import { lstat, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN;

/** The skill folders OpenCode reads, per scope. Nothing else can be reached. */
const ROOTS = {
  opencode: { global: ['.config', 'opencode', 'skills'], project: ['.opencode', 'skills'] },
  claude: { global: ['.claude', 'skills'], project: ['.claude', 'skills'] },
  agents: { global: ['.agents', 'skills'], project: ['.agents', 'skills'] },
} as const;

/** No slash, no leading dot, so a segment can never walk out of its folder. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** OpenCode stops searching six directories below a source root. */
const MAX_SEGMENTS = 6;

type Answer = { status: number; body: Record<string, unknown> };

const bad = (message: string): Answer => ({ status: 400, body: { message } });

type Target = { path: string; form: 'dir' | 'file' };

const skillPath = (input: Record<string, unknown>): Target | Answer => {
  const { scope, source, segments, form, directory } = input;

  if (typeof source !== 'string' || !(source in ROOTS)) return bad('That is not a skill folder.');
  if (form !== 'dir' && form !== 'file') return bad('Unknown skill shape.');
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > MAX_SEGMENTS) {
    return bad('That is not a skill this extension can remove.');
  }
  for (const segment of segments) {
    if (typeof segment !== 'string' || !SEGMENT.test(segment) || segment.includes('..')) {
      return bad('That is not a skill name this extension can remove.');
    }
  }
  // A single markdown file is a skill only at the root of its folder.
  if (form === 'file' && segments.length !== 1) return bad('That is not a skill file.');

  const parts = ROOTS[source as keyof typeof ROOTS];
  let root: string;
  if (scope === 'global') {
    root = join(homedir(), ...parts.global);
  } else if (scope === 'project') {
    if (typeof directory !== 'string' || directory === '' || !isAbsolute(directory)) {
      return bad('A project skill needs the project folder.');
    }
    root = join(resolve(directory), ...parts.project);
  } else {
    return bad('Unknown scope.');
  }

  const names = segments as string[];
  const tail = form === 'file' ? `${names[0]}.md` : names.join(sep);
  const target = resolve(root, tail);
  // Belt and braces: the built path must still sit inside its folder.
  if (target !== root && !target.startsWith(resolve(root) + sep)) {
    return bad('That path is outside the skills folder.');
  }
  return { path: target, form };
};

const remove = async (body: string): Promise<Answer> => {
  let input: unknown;
  try {
    input = JSON.parse(body || '{}');
  } catch {
    return bad('Could not read the request.');
  }
  if (!input || typeof input !== 'object') return bad('Could not read the request.');

  const target = skillPath(input as Record<string, unknown>);
  if ('status' in target) return target;

  // lstat, not stat: a symlink is not a regular file or folder, so one that
  // points somewhere else is refused instead of followed.
  const info = await lstat(target.path).catch(() => null);
  if (!info) return { status: 404, body: { message: 'That skill is already gone.' } };

  try {
    if (target.form === 'file') {
      if (!info.isFile()) return bad('That path is not a skill file.');
      await unlink(target.path);
    } else {
      if (!info.isDirectory()) return bad('That path is not a skill folder.');
      // A folder is only a skill when it holds a SKILL.md, and only then is it
      // deleted with what it contains.
      const inside = await lstat(join(target.path, 'SKILL.md')).catch(() => null);
      if (!inside || !inside.isFile()) return bad('That folder holds no SKILL.md, so it is not a skill.');
      await rm(target.path, { recursive: true });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 500, body: { message: `Could not delete it: ${reason}` } };
  }
  return { status: 200, body: { deleted: true, path: target.path } };
};

const server = http.createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (path === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    return;
  }
  if (path !== '/delete' || request.method !== 'POST') {
    response.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
    return;
  }

  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 8192) request.destroy();
  });
  request.on('end', () => {
    remove(body).then(
      (answer) => {
        response
          .writeHead(answer.status, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(answer.body));
      },
      () => {
        response
          .writeHead(500, { 'Content-Type': 'application/json' })
          .end('{"message":"The helper failed."}');
      },
    );
  });
});

server.listen(port, '127.0.0.1');
