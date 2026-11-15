// service/main.ts
import http from "node:http";
import { lstat, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN;
var ROOTS = {
  opencode: { global: [".config", "opencode", "skills"], project: [".opencode", "skills"] },
  claude: { global: [".claude", "skills"], project: [".claude", "skills"] },
  agents: { global: [".agents", "skills"], project: [".agents", "skills"] }
};
var SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
var MAX_SEGMENTS = 6;
var bad = (message) => ({ status: 400, body: { message } });
var skillPath = (input) => {
  const { scope, source, segments, form, directory } = input;
  if (typeof source !== "string" || !(source in ROOTS))
    return bad("That is not a skill folder.");
  if (form !== "dir" && form !== "file")
    return bad("Unknown skill shape.");
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > MAX_SEGMENTS) {
    return bad("That is not a skill this extension can remove.");
  }
  for (const segment of segments) {
    if (typeof segment !== "string" || !SEGMENT.test(segment) || segment.includes("..")) {
      return bad("That is not a skill name this extension can remove.");
    }
  }
  if (form === "file" && segments.length !== 1)
    return bad("That is not a skill file.");
  const parts = ROOTS[source];
  let root;
  if (scope === "global") {
    root = join(homedir(), ...parts.global);
  } else if (scope === "project") {
    if (typeof directory !== "string" || directory === "" || !isAbsolute(directory)) {
      return bad("A project skill needs the project folder.");
    }
    root = join(resolve(directory), ...parts.project);
  } else {
    return bad("Unknown scope.");
  }
  const names = segments;
  const tail = form === "file" ? `${names[0]}.md` : names.join(sep);
  const target = resolve(root, tail);
  if (target !== root && !target.startsWith(resolve(root) + sep)) {
    return bad("That path is outside the skills folder.");
  }
  return { path: target, form };
};
var remove = async (body) => {
  let input;
  try {
    input = JSON.parse(body || "{}");
  } catch {
    return bad("Could not read the request.");
  }
  if (!input || typeof input !== "object")
    return bad("Could not read the request.");
  const target = skillPath(input);
  if ("status" in target)
    return target;
  const info = await lstat(target.path).catch(() => null);
  if (!info)
    return { status: 404, body: { message: "That skill is already gone." } };
  try {
    if (target.form === "file") {
      if (!info.isFile())
        return bad("That path is not a skill file.");
      await unlink(target.path);
    } else {
      if (!info.isDirectory())
        return bad("That path is not a skill folder.");
      const inside = await lstat(join(target.path, "SKILL.md")).catch(() => null);
      if (!inside || !inside.isFile())
        return bad("That folder holds no SKILL.md, so it is not a skill.");
      await rm(target.path, { recursive: true });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 500, body: { message: `Could not delete it: ${reason}` } };
  }
  return { status: 200, body: { deleted: true, path: target.path } };
};
var server = http.createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    return;
  }
  if (path !== "/delete" || request.method !== "POST") {
    response.writeHead(404, { "Content-Type": "application/json" }).end("{}");
    return;
  }
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
    if (body.length > 8192)
      request.destroy();
  });
  request.on("end", () => {
    remove(body).then((answer) => {
      response.writeHead(answer.status, { "Content-Type": "application/json" }).end(JSON.stringify(answer.body));
    }, () => {
      response.writeHead(500, { "Content-Type": "application/json" }).end('{"message":"The helper failed."}');
    });
  });
});
server.listen(port, "127.0.0.1");
