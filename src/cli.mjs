#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import yaml from "js-yaml";
import { compactList, DEFAULT_LIST_KEYS, stripResponse } from "./format.mjs";

const CFG = `${homedir()}/.selis`;
const AUTH = `${CFG}/auth.json`;
const ENVS = {
  local: process.env.SELIS_BASE_URL || "http://localhost:3000",
  dev: "https://selis.dev",
  demo: "https://demo.selis.app",
  prod: "https://selis.app",
};
const COMMANDS = ["list", "get", "create", "update", "delete", "describe", "logout", "auth"];
const SKIP_FIELDS = new Set(["id", "createdAt", "updatedAt", "organizationId", "profileId", "deletedAt", "version"]);

// ── Auth ──
async function loadAuth() {
  try {
    return JSON.parse(await readFile(AUTH, "utf8"));
  } catch {
    return null;
  }
}
async function saveAuth(a) {
  await mkdir(CFG, { recursive: true });
  await writeFile(AUTH, JSON.stringify(a));
}

// ── Auth via browser callback (used by "selis auth" command) ──
async function handleAuth(baseUrl, auth, save) {
  console.log("Setting up browser-based authentication...\n");

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    if (token) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>Authenticated!</h2><p>Token received. You can close this tab.</p>");
      auth.token = token;
      auth.env = auth.env || "local";
      // Save the actual base URL so subsequent calls work without SELIS_BASE_URL env
      auth.baseUrl = baseUrl;
      save(auth).then(() => server.close());
      console.error("\nAuthenticated! Token saved to ~/.selis/auth.json");
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Waiting for token...");
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      if (!port) { reject(new Error("No port")); return; }

      const authUrl = `${baseUrl}/authorize?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/callback`)}`;
      console.log(`Open this URL in your browser:`);
      console.log(`  ${authUrl}`);
      console.log(`\nLog in and click Authorize.`);
      console.log(`Waiting for callback on http://127.0.0.1:${port}...`);

      // Try to open browser automatically
      try {
        const platform = process.platform;
        if (platform === "darwin") execSync(`open "${authUrl}"`, { stdio: "ignore", timeout: 3000 });
        else if (platform === "linux") execSync(`xdg-open "${authUrl}" 2>/dev/null || echo -n`, { stdio: "ignore", timeout: 3000 });
        else if (platform === "win32") execSync(`start "" "${authUrl}"`, { stdio: "ignore", timeout: 3000 });
      } catch { /* browser open is best-effort */ }

      server.on("close", resolve);
    });
    server.on("error", reject);
  });

  console.log("\nAuthenticated! Token saved to ~/.selis/auth.json");
}

// ── API ──
async function callApi(token, baseUrl, method, path, body) {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.ok) {
    const data = await r.json();
    // Extract total from Content-Range header (e.g. "action */43" or "action 3-5/43")
    const cr = r.headers.get("content-range");
    let total = 0;
    if (cr) {
      const m = cr.match(/\/(\d+)$/);
      if (m) total = parseInt(m[1], 10);
    }
    return { ok: true, data, total };
  }
  const text = await r.text();
  return { ok: false, error: `${r.status} ${text}` };
}

// ── Output ──
function print(data, format) {
  if (format === "yaml") {
    console.log(yaml.dump(data, { indent: 2, lineWidth: 120 }));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

// ── Discover entity fields ──
async function discoverFields(auth, baseUrl, entity) {
  const r = await callApi(auth.token, baseUrl, "GET", `/org/${auth.org}/${entity}?limit=1&meta=none&keys=`);
  if (!r.ok) return null;
  const sample = Array.isArray(r.data) ? r.data[0] : null;
  if (!sample) return [];
  return Object.keys(sample).filter((k) => !SKIP_FIELDS.has(k));
}

// ── Parse data (auto-detect YAML/JSON) ──
function parseData(str, filePath) {
  let content, isYaml;
  if (filePath) {
    try {
      content = readFileSync(filePath, "utf8");
    } catch (e) {
      console.error(`Error reading "${filePath}":`, e.message);
      return null;
    }
    isYaml = /\.ya?ml$/i.test(filePath);
  } else if (str) {
    content = str.trim();
    isYaml = /^[a-zA-Z0-9_"'\-\/#]/.test(content) && !content.startsWith("{");
  } else {
    return null;
  }

  if (isYaml) {
    try {
      return yaml.load(content);
    } catch (e) {
      console.error("YAML parse error:", e.message);
      return null;
    }
  }
  try {
    return JSON.parse(content);
  } catch (e) {
    console.error("JSON parse error:", e.message);
    return null;
  }
}

// ── Interactive create/update prompts ──
async function promptForFields(entity, fields, existingData) {
  const { default: enquirer } = await import("enquirer");
  const { Input, Select, MultiSelect, Confirm } = enquirer;
  const result = { ...(existingData || {}) };

  console.log(`\n  selis — Creating a new "${entity}" entity`);
  console.log("  " + "━".repeat(50));

  for (const field of fields) {
    if (result[field] !== undefined) continue;

    // Skip reference ID fields — user can add via --data if needed
    if (field.endsWith("Id") || field === "id" || field === "organizationId" || field === "profileId") {
      continue;
    }

    // Choose prompt type based on field name heuristics
    const lower = field.toLowerCase();
    let answer;

    if (["status", "type", "category", "severity", "priority"].includes(lower)) {
      // Suggest common values but allow custom input
      const suggestions = {
        status: ["open", "closed", "in_progress", "on_hold", "cancelled"],
        severity: ["low", "medium", "high", "critical"],
        priority: ["low", "medium", "high", "urgent"],
        type: [],
        category: [],
      };
      const choices = suggestions[lower] || [];
      if (choices.length) {
        answer = await new Select({
          name: field,
          message: `${field}`,
          choices,
          initial: 0,
        }).catch(() => null);
      } else {
        answer = await new Input({ name: field, message: `${field}:` }).catch(() => null);
      }
    } else if (["tags", "labels", "categories"].includes(lower)) {
      // Multi-value field
      answer = await new Input({
        name: field,
        message: `${field} (comma-separated):`,
        initial: "",
      }).catch(() => null);
      if (answer && typeof answer === "string" && answer.includes(",")) {
        answer = answer.split(",").map((s) => s.trim()).filter(Boolean);
      }
    } else if (lower.includes("date") || lower.includes("time")) {
      answer = await new Input({
        name: field,
        message: `${field} (YYYY-MM-DD):`,
        initial: "",
      }).catch(() => null);
    } else {
      // Plain text input
      answer = await new Input({ name: field, message: `${field}:`, initial: "" }).catch(() => null);
    }

    if (answer !== null && answer !== undefined && answer !== "") {
      if (typeof answer === "object" && answer[field] !== undefined) {
        result[field] = answer[field];
      } else if (!(typeof answer === "object")) {
        result[field] = answer;
      }
    }
  }

  if (Object.keys(result).length === 0) {
    console.log("  No fields entered. Skipping.");
    return null;
  }

  // Preview
  console.log("\n  Preview:");
  const preview = yaml.dump(result, { indent: 2, lineWidth: 120 });
  console.log(preview
    .split("\n")
    .map((l) => "  " + l)
    .join("\n"));

  const confirm = await new Confirm({
    name: "confirm",
    message: `Create this ${entity}?`,
    initial: true,
  }).catch(() => ({ confirm: false }));

  if (typeof confirm === "object" && confirm.confirm === false) return null;
  if (confirm === false) return null;
  return result;
}

// ── Main ──
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`selis — CLI for Selis TMiS

USAGE
  selis [--env ENV] [--org ORG] [--format json|yaml] <entity> <command> [id] [flags]

COMMANDS
  list        selis actions list [--scope focus] [--search TEXT] [--filter k=v] [--limit N] [--offset N] [--full]
  get         selis actions get <id>
  create      selis actions create --data 'title: ...'
  update      selis actions update <id> --data 'status: closed'
  delete      selis actions delete <id>
  describe    selis actions describe
  logout      selis logout

FLAGS
  --env ENV         Environment: local, dev, demo, prod
  --org ORG         Organization reference
  --scope SCOPE     Focus filter: mine (assignedToMe) | followed (following) | all (default)
  --format FORMAT   Output: compact (default for list) | json | yaml
  --data YAML/JSON  Inline data for create/update
  --data-file PATH  Data file (.yaml, .yml, .json)
  --filter K=V      Filter for list (repeatable)
  --search TEXT     Text search across item titles
  --limit N         Max rows for list (default 15, max 40)
  --offset N        Pagination offset for list (default 0)
  --full            Return raw JSON for list (no compact projection)

AUTH
  Shares ~/.selis/auth.json with selis-mcp.
  Run selis-mcp first to authenticate, then use this CLI.
`);
    process.exit(0);
  }

  // Parse flags
  let envFlag, orgFlag, format, dataStr, dataFile, filters = [];
  let limit = 15, offset = 0, full = false, scope, search;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--env" && args[i + 1]) envFlag = args[++i];
    else if (a === "--org" && args[i + 1]) orgFlag = args[++i];
    else if (a === "--format" && args[i + 1]) format = args[++i];
    else if (a === "--data" && args[i + 1]) dataStr = args[++i];
    else if (a === "--data-file" && args[i + 1]) dataFile = args[++i];
    else if (a === "--scope" && args[i + 1]) scope = args[++i];
    else if (a === "--search" && args[i + 1]) search = args[++i];
    else if (a === "--limit" && args[i + 1]) limit = parseInt(args[++i], 10) || 15;
    else if (a === "--offset" && args[i + 1]) offset = parseInt(args[++i], 10) || 0;
    else if (a === "--full") full = true;
    else if (a === "--filter" && args[i + 1]) {
      const f = args[++i], eq = f.indexOf("=");
      if (eq > 0) filters.push([f.slice(0, eq), f.slice(eq + 1)]);
    } else if (!a.startsWith("--")) positional.push(a);
  }

  let entity = positional[0];
  let command = positional[1];
  let id = positional[2];

  if (!entity || !command) {
    // Special case: standalone commands (logout, auth)
    if (entity === "logout" || entity === "auth") {
      command = entity;
      entity = "";
    } else {
      console.error("Usage: selis <entity> <command>");
      process.exit(1);
    }
  }
  if (!COMMANDS.includes(command)) {
    console.error(`Unknown command "${command}". Available: ${COMMANDS.join(", ")}`);
    process.exit(1);
  }

  // Load auth (optional — auth and logout commands work without it)
  const auth = await loadAuth() || { env: envFlag, token: null, org: orgFlag };
  if (!auth.token && command !== "auth" && command !== "logout") {
    console.error(
      "Not authenticated. Run this to log in first:\n" +
      `  SELIS_BASE_URL=https://localhost:3016 NODE_TLS_REJECT_UNAUTHORIZED=0 selis auth`,
    );
    process.exit(1);
  }

  const baseUrl = envFlag ? ENVS[envFlag] : (auth.baseUrl || (auth.env ? ENVS[auth.env] : ENVS.local));
  const org = orgFlag || auth.org;
  if (!baseUrl) {
    console.error("Set env. Use --env flag.");
    process.exit(1);
  }

  try {
    switch (command) {
      case "list": {
        const params = new URLSearchParams(filters);
        params.set("limit", String(limit));
        params.set("meta", "none");
        if (offset > 0) params.set("offset", String(offset));
        // Populate relations needed for compact output (owner, assignee, group, item)
        if (!full) params.set("keys", DEFAULT_LIST_KEYS);
        if (search) params.set("filter", search);
        // Scope filter: --scope mine → assignedOnly, --scope followed → followingOnly
        const scopeMap = { mine: "assignedOnly", assigned: "assignedOnly", followed: "followingOnly", following: "followingOnly" };
        if (scope && scopeMap[scope.toLowerCase()]) params.set("scope", scopeMap[scope.toLowerCase()]);
        const r = await callApi(auth.token, baseUrl, "GET", `/org/${org}/${entity}?${params}`);
        if (!r.ok) die(r.error);
        if (full || format === "json" || format === "yaml") {
          print(r.data, format || "json");
        } else {
          console.log(compactList(r.data, { entity, offset, limit, total: r.total }));
        }
        break;
      }
      case "get": {
        if (!id) die("Usage: selis get <entity> <id>");
        const r = await callApi(auth.token, baseUrl, "GET", `/org/${org}/${entity}/${id}?meta=none`);
        if (!r.ok) die(r.error);
        print(stripResponse(r.data), format);
        break;
      }
      case "create": {
        let data = parseData(dataStr, dataFile);
        if (!data) {
          const fields = await discoverFields(auth, baseUrl, entity);
          if (fields && fields.length) {
            data = await promptForFields(entity, fields, null);
          }
        }
        if (!data) die("Provide data via --data, --data-file, or run without flags for interactive mode.");
        const r = await callApi(auth.token, baseUrl, "POST", `/org/${org}/${entity}?meta=none`, data);
        if (!r.ok) die(r.error);
        print(stripResponse(r.data), format);
        break;
      }
      case "update": {
        if (!id) die("Usage: selis update <entity> <id> --data ...");
        let data = parseData(dataStr, dataFile);
        if (!data) {
          const fields = await discoverFields(auth, baseUrl, entity);
          if (fields && fields.length) {
            data = await promptForFields(entity, fields, null);
          }
        }
        if (!data) die("Provide data via --data, --data-file, or run without flags for interactive mode.");
        const r = await callApi(auth.token, baseUrl, "PATCH", `/org/${org}/${entity}/${id}?meta=none`, data);
        if (!r.ok) die(r.error);
        print(stripResponse(r.data), format);
        break;
      }
      case "delete": {
        if (!id) die("Usage: selis delete <entity> <id>");
        const r = await callApi(auth.token, baseUrl, "DELETE", `/org/${org}/${entity}/${id}`);
        if (!r.ok) die(r.error);
        console.log("Deleted.");
        break;
      }
      case "describe": {
        const fields = await discoverFields(auth, baseUrl, entity);
        if (fields === null) die(`No data found for "${entity}".`);
        print({ entity, fields }, format);
        break;
      }
      case "auth": {
        await handleAuth(baseUrl, auth, saveAuth);
        break;
      }
      case "logout": {
        auth.token = null;
        await saveAuth(auth);
        console.log("Logged out. Token cleared from ~/.selis/auth.json");
        break;
      }
    }
  } catch (e) {
    die(e.message);
  }
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
