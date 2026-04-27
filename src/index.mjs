#!/usr/bin/env node

import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import yaml from "js-yaml";
import { compactList, DEFAULT_LIST_KEYS, stripResponse, parseRefId, fmtCommentThread } from "./format.mjs";
import { buildDescribeText } from "./pmo-knowledge.mjs";

const CFG = `${homedir()}/.selis`;
const AUTH = `${CFG}/auth.json`;
const ENVS = {
  local: process.env.SELIS_BASE_URL || "http://localhost:3000",
  dev:  "https://selis.dev",
  demo: "https://demo.selis.app",
  prod: "https://selis.app",
};

// In-memory PKCE auth code store
const authCodes = new Map();
const AUTH_CODE_TTL = 5 * 60 * 1000;
function sha256b64(s) {
  return createHash("sha256").update(s).digest("base64")
    .replace(/=+$/g,"").replace(/\+/g,"-").replace(/\//g,"_");
}
function pruneCodes() {
  const now = Date.now();
  for (const [c, e] of authCodes.entries()) if (e.expiresAt < now) authCodes.delete(c);
}

function loadAuth() { return readFile(AUTH, "utf8").then(JSON.parse).catch(() => null); }
function saveAuth(a) { return mkdir(CFG, { recursive: true }).then(() => writeFile(AUTH, JSON.stringify(a))); }

let authUrl = ""; // exposed via /auth-url for frontend consumption

function oauth(env) {
  const baseUrl = ENVS[env];
  const mcpServerUrl = httpsFlag ? `https://localhost:${httpsPort}` : `http://localhost:${httpPort}`;
  // No ephemeral callback server needed — browser will POST token to MCP's /auth-token
  authUrl = `${baseUrl}/authorize?redirect_uri=${encodeURIComponent(mcpServerUrl + "/auth-token")}`;
  console.error(`Open: ${authUrl}`);
}

async function api(token, url, method, path, body) {
  const r = await fetch(`${url}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.ok) {
    const data = await r.json();
    const cr = r.headers.get("content-range");
    let total = 0;
    if (cr) { const m = cr.match(/\/(\d+)$/); if (m) total = parseInt(m[1], 10); }
    return { ok: true, data, total };
  }
  return { ok: false, error: `${r.status} ${await r.text()}` };
}

// ── Parse CLI ──
const env = process.argv[2] || process.env.SELIS_ENV || "";
if (!env || !ENVS[env]) {
  // In stdio mode (MCP clients), just log and exit — CLI args not available
  if (process.argv.length <= 3 && !process.argv.includes("--http")) {
    console.error(`Selis MCP Server — set SELIS_ENV and SELIS_ORG env vars to configure.\nUsage: \n  SELIS_ENV=local SELIS_ORG=CalxC npx @calx/selis-mcp\nOr run in HTTP mode:\n  node index.mjs local CalxC --http 3774`);
    process.exit(0);
  }
  console.error(`Usage: node index.mjs ${Object.keys(ENVS).join("|")} [org-ref] [--http PORT]`);
  process.exit(1);
}
const cliOrg = process.argv[3] || process.env.SELIS_ORG || "";
const httpIdx = process.argv.indexOf("--http");
const httpFlag = httpIdx !== -1;
const httpPort = httpFlag ? parseInt(process.argv[httpIdx + 1]) || 3773 : 0;
const httpsIdx = process.argv.indexOf("--https");
const httpsFlag = httpsIdx !== -1;
const httpsPort = httpsFlag ? parseInt(process.argv[httpsIdx + 1]) || 3774 : 0;
const CERT = process.env.HTTPS_CERT_FILE || "";
const KEY  = process.env.HTTPS_KEY_FILE  || "";
let certPem = ""; let keyPem = "";
try { if (CERT) certPem = readFileSync(CERT, "utf8"); } catch {}
try { if (KEY)  keyPem  = readFileSync(KEY, "utf8");  } catch {}

// ⚠️ Skip TLS verification for self-signed certs (local dev)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED || "0";

// ── Auth (load cached. fire-and-forget OAuth if missing. DON'T BLOCK SERVER) ──
let auth = await loadAuth();
let authPending = false;

// Accept token from env var (plugin userConfig) as alternative to file-based auth
const envToken = process.env.SELIS_TOKEN || process.env.CLAUDE_PLUGIN_OPTION_SELIS_TOKEN || "";
if (envToken) {
  auth = { env, token: envToken, org: cliOrg || "" };
  await saveAuth(auth);
} else if (!auth || auth.env !== env) {
  auth = { env, token: null, org: cliOrg || "" };
  authPending = true;
} else if (cliOrg && cliOrg !== auth.org) {
  auth.org = cliOrg;
  await saveAuth(auth);
}

async function doAuth() {
  oauth(env);
  // Token will arrive via POST /auth-token (from browser after authorize page)
}
// Only auto-trigger OAuth in HTTP mode where the callback server exists.
// In stdio mode, the user must call the `selis_login` tool, which starts an ephemeral callback server.
const isHttpMode = process.argv.includes("--http") || process.argv.includes("--https");
if (authPending && isHttpMode) { doAuth(); } // fire and forget — don't block server start

// ── Tools ──
const tools = [
  { name: "selis_list",    description: "List entities. Supports text search, scope, filters, and pagination. Returns compact one-line summaries (default 15, max 40 rows).", annotations: { readOnlyHint: true },  inputSchema: { type: "object", properties: { entity: { type: "string", description: "Entity name (e.g. actions, risks, projects)" }, filters: { type: "object", description: "Key-value filters (e.g. {status: 'open'})" }, search: { type: "string", description: "Text search across item titles" }, scope: { type: "string", description: "Focus filter: 'mine' (assigned), 'followed' (following), or 'both'" }, limit: { type: "number", description: "Max rows (default 15, max 40)" }, offset: { type: "number", description: "Pagination offset (default 0)" }, format: { type: "string", description: "'compact' (default) or 'full' for raw JSON" } }, required: ["entity"] } },
  { name: "selis_get",     description: "Get entity by ID", annotations: { readOnlyHint: true },  inputSchema: { type: "object", properties: { entity: { type: "string" }, id: { type: "string" } }, required: ["entity", "id"] } },
  { name: "selis_create",  description: "Create entity. Use selis_describe first to see valid enum values. WARNING: owner/assignee/group/item fields expect UUIDs, not names.", annotations: { openWorldHint: true },  inputSchema: { type: "object", properties: { entity: { type: "string" }, data: { type: "object" } }, required: ["entity", "data"] } },
  { name: "selis_update",  description: "Update entity (data as YAML or JSON object)", annotations: { destructiveHint: true }, inputSchema: { type: "object", properties: { entity: { type: "string" }, id: { type: "string" }, data: { type: "object" } }, required: ["entity", "id", "data"] } },
  { name: "selis_delete",  description: "Delete entity", annotations: { destructiveHint: true }, inputSchema: { type: "object", properties: { entity: { type: "string" }, id: { type: "string" } }, required: ["entity", "id"] } },
  { name: "selis_describe", description: "Show entity fields with PMO concepts, types, and valid enum values. Call before creating or updating.", annotations: { readOnlyHint: true },  inputSchema: { type: "object", properties: { entity: { type: "string" } }, required: ["entity"] } },
  { name: "selis_comments_list", description: "List comments for an item. If commentId is provided, returns that comment and its replies.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { entity: { type: "string", description: "e.g. actions, issues, risks" }, id: { type: "string", description: "Item ID or prefixed ref (e.g. ACT-0859)" }, commentId: { type: "string", description: "Optional — get this specific comment + replies" } }, required: ["entity", "id"] } },
  { name: "selis_comment_add", description: "Add a comment to an item, or reply to an existing comment.", annotations: { openWorldHint: true }, inputSchema: { type: "object", properties: { entity: { type: "string", description: "e.g. actions, issues, risks" }, id: { type: "string", description: "Item ID or prefixed ref" }, content: { type: "string", description: "Comment text" }, parent: { type: "string", description: "Optional — comment ID to reply to" } }, required: ["entity", "id", "content"] } },
  { name: "selis_logout",  description: "Clear token", annotations: { destructiveHint: true }, inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "selis_login",   description: "Returns the OAuth URL for browser-based login. Call this when the user is not authenticated. Show the URL to the user so they can click it and authorize.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "selis_orgs",    description: "List available organizations the user can access. After authentication, call this to discover which organization the user belongs to, then ask them to pick one and call selis_set_org.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "selis_set_org", description: "Set the active organization after discovering available ones with selis_orgs. The user must pick one from the list.", inputSchema: { type: "object", properties: { org: { type: "string", description: "Organization reference/slug from selis_orgs list" } }, required: ["org"] } },
];

function authCheck(token) {
  if (!token && authPending) return { error: { code: -32001, message: "Auth pending. Visit the URL printed on server startup to authorize." } };
  if (!token) return { error: { code: -32001, message: "Not authenticated. Use OAuth to obtain a Bearer token." } };
  return null;
}

async function handle(msg, reqToken) {
  // reqToken = per-request Bearer token (HTTP mode), falls back to global auth.token (stdio mode)
  const token = reqToken || auth.token;
  const id = msg.id;
  if (msg.method === "initialize") {
    // Echo the client's protocolVersion if known, else fall back to our latest
    const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
    const clientVer = msg.params?.protocolVersion;
    const protocolVersion = SUPPORTED.includes(clientVer) ? clientVer : SUPPORTED[0];
    return { result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "selis-mcp", title: "Selis PMO", version: "0.2.0" } } };
  }
  if (msg.method === "notifications/initialized") return null; // ack-only notification, no response
  if (msg.method === "ping") return { result: {} };
  if (msg.method === "tools/list")
    return { result: { tools } };

  if (msg.method === "tools/call") {
    const unauthorized = authCheck(token);
    if (unauthorized) return unauthorized;

    const { name, arguments: args } = msg.params || {};
    console.error(`→ ${name}`, JSON.stringify(args || {}).slice(0, 200));
    let { entity, data, id: idParam, filters } = args || {};

    // Accept YAML or JSON for the data parameter
    if (typeof data === "string") {
      try {
        data = yaml.load(data);
      } catch {
        try { data = JSON.parse(data); } catch {}
      }
    }

    if (name === "selis_logout") { auth.token = null; await saveAuth(auth); return { result: { content: [{ type: "text", text: "Logged out." }] } }; }
    if (name === "selis_login") {
      if (token) {
        return { result: { content: [{ type: "text", text: "Already authenticated. Call selis_orgs to see available organizations." }] } };
      }
      // Start ephemeral HTTP server for OAuth callback, then show URL
      const authPort = 0; // random port
      const authServer = createServer((req2, res2) => {
        if (req2.method === "OPTIONS") { head(res2, 204); res2.end(); return; }
        const u2 = new URL(req2.url, "http://localhost");
        if (u2.pathname === "/auth-token" && req2.method === "POST") {
          let body = "";
          req2.on("data", c => body += c);
          req2.on("end", async () => {
            try {
              const { token } = JSON.parse(body);
              if (token) {
                auth.token = token;
                authPending = false;
                if (!auth.org) {
                  const me = await api(token, ENVS[env], "GET", "/me");
                  if (me.ok && me.data?.organizations?.length) {
                    const orgs = me.data.organizations.map(o => ({ ref: o.reference, name: o.name })).filter(o => o.ref);
                    if (orgs.length === 1) auth.org = orgs[0].ref;
                    else if (orgs.length > 1 && auth.org && !orgs.find(o => o.ref === auth.org)) {}
                    auth.availableOrgs = orgs;
                  }
                }
                await saveAuth(auth);
                head(res2, 200); res2.end('{"status":"ok"}');
                authServer.close();
              } else { head(res2, 400); res2.end('{"error":"missing token"}'); }
            } catch { head(res2, 400); res2.end('{"error":"invalid json"}'); }
          });
          return;
        }
        head(res2, 404); res2.end("Not found");
      });
      const port = await new Promise(r => authServer.listen(0, () => r(authServer.address().port)));
      authUrl = `${ENVS[env]}/authorize?redirect_uri=${encodeURIComponent(`http://localhost:${port}/auth-token`)}`;
      return { result: { content: [{ type: "text", text: `Open this URL in your browser to authenticate:\n${authUrl}\n\nAfter you log in, the token is saved and you're ready. Then call selis_orgs to pick your organization.` }] } };
    }
    if (name === "selis_orgs") {
      // Try cached orgs first, then fetch from API
      let orgs = auth.availableOrgs;
      if (!orgs && token) {
        const me = await api(token, ENVS[env], "GET", "/me");
        if (me.ok && me.data?.organizations?.length) {
          orgs = me.data.organizations.map(o => ({ ref: o.reference, name: o.name })).filter(o => o.ref);
          auth.availableOrgs = orgs;
          await saveAuth(auth);
        }
      }
      if (!orgs || orgs.length === 0) {
        return token
          ? { result: { content: [{ type: "text", text: "No organizations found for this account." }] } }
          : { result: { content: [{ type: "text", text: "Not authenticated. Call selis_login first to log in." }] } };
      }
      const current = auth.org ? `(current: ${auth.org})` : "(none selected yet)";
      const list = orgs.map(o => `  - ${o.ref}  (${o.name})`).join("\n");
      return { result: { content: [{ type: "text", text: `Available organizations ${current}:\n${list}` }] } };
    }
    if (name === "selis_set_org") {
      const orgSlug = args?.org;
      if (!orgSlug) return { error: { code: -32602, message: "Missing org parameter" } };
      // Validate against available orgs if we have them
      if (auth.availableOrgs) {
        const match = auth.availableOrgs.find(o => o.ref?.toLowerCase() === orgSlug.toLowerCase());
        if (!match) {
          const available = auth.availableOrgs.map(o => o.ref).join(", ");
          return { error: { code: -32000, message: `Organization "${orgSlug}" not found. Available: ${available}` } };
        }
        auth.org = match.ref;
      } else { auth.org = orgSlug; }
      await saveAuth(auth);
      return { result: { content: [{ type: "text", text: `Organization set to: ${auth.org}` }] } };
    }
    if (!entity) return { error: { code: -32602, message: "Missing entity" } };

    const base = ENVS[auth.env], org = auth.org;
    let r;
    try {
      // Resolve prefixed ref IDs like "ACT-0859" → UUID for get/update/delete/comment tools
      if (idParam && (name === "selis_get" || name === "selis_update" || name === "selis_delete" || name === "selis_comments_list" || name === "selis_comment_add")) {
        const parsed = parseRefId(idParam);
        if (parsed) {
          const searchR = await api(token, base, "GET", `/org/${org}/${parsed.entity}?reference=${parsed.ref}&limit=50&keys=id,reference&meta=none`);
          if (searchR.ok && Array.isArray(searchR.data)) {
            const match = searchR.data.find(r => r.reference === parsed.ref);
            if (match) { idParam = match.id; }
            else { return { error: { code: -32000, message: `No ${parsed.entity} found with reference #${parsed.ref}` } }; }
          } else {
            return { error: { code: -32000, message: `No ${parsed.entity} found with reference #${parsed.ref}` } };
          }
        }
      }
      if (name === "selis_list") {
        const params = new URLSearchParams(filters || {});
        const limit = Math.min(args?.limit || 15, 40);
        const offset = args?.offset || 0;
        const fmt = args?.format || "compact";
        const scopeMap = { mine: "assignedOnly", assigned: "assignedOnly", followed: "followingOnly", following: "followingOnly" };
        params.set("limit", String(limit));
        params.set("meta", "none");
        if (offset > 0) params.set("offset", String(offset));
        if (fmt === "compact") params.set("keys", DEFAULT_LIST_KEYS);
        if (args?.scope && scopeMap[args.scope.toLowerCase()]) params.set("scope", scopeMap[args.scope.toLowerCase()]);
        if (args?.search) params.set("filter", args.search);
        r = await api(token, base, "GET", `/org/${org}/${entity}?${params}`);
        if (r.ok && fmt === "compact") {
          const text = compactList(r.data, { entity, offset, limit, total: r.total });
          return { result: { content: [{ type: "text", text }] } };
        }
      }
      else if (name === "selis_get")    r = await api(token, base, "GET", `/org/${org}/${entity}/${idParam}?meta=none`);
      else if (name === "selis_create") r = await api(token, base, "POST", `/org/${org}/${entity}?meta=none`, data);
      else if (name === "selis_update") r = await api(token, base, "PATCH", `/org/${org}/${entity}/${idParam}?meta=none`, data);
      else if (name === "selis_delete") r = await api(token, base, "DELETE", `/org/${org}/${entity}/${idParam}`);
      else if (name === "selis_describe") {
        const r = await api(token, base, "GET", `/org/${org}/${entity}?limit=1&meta=none&keys=`);
        if (!r.ok) return { error: { code: -32000, message: r.error } };
        const sample = Array.isArray(r.data) ? r.data[0] : null;
        if (!sample) return { result: { content: [{ type: "text", text: `No "${entity}" records found in org "${org}".` }] } };
        const text = buildDescribeText(entity, sample);
        return { result: { content: [{ type: "text", text }] } };
      }
      else if (name === "selis_comments_list") {
        const commentId = args?.commentId || "";
        if (commentId) {
          // Get replies thread: first fetch root comments to find the parent, then fetch replies
          const rootR = await api(token, base, "GET", `/org/${org}/${entity}/${idParam}/comments`);
          const rootComments = Array.isArray(rootR.data) ? rootR.data : [];
          const parent = rootComments.find(c => c.id === commentId);
          // Thread replies endpoint may 500 due to backend bug → graceful fallback
          let replies = [];
          try {
            const replyR = await api(token, base, "GET", `/org/${org}/${entity}/${idParam}/comments/${commentId}`);
            replies = (Array.isArray(replyR.data) ? replyR.data : []).filter(c => c.id !== commentId);
          } catch { /* fallback to just parent */ }
          const all = parent ? [parent, ...replies] : replies;
          if (all.length === 0) return { result: { content: [{ type: "text", text: "No comments found." }] } };
          const text = fmtCommentThread(all);
          return { result: { content: [{ type: "text", text }] } };
        } else {
          r = await api(token, base, "GET", `/org/${org}/${entity}/${idParam}/comments`);
          if (!r.ok) return { error: { code: -32000, message: r.error } };
          const comments = Array.isArray(r.data) ? r.data : [];
          if (comments.length === 0) return { result: { content: [{ type: "text", text: "No comments." }] } };
          return { result: { content: [{ type: "text", text: comments.map(c => fmtCommentThread([c])).join("\n") }] } };
        }
      }
      else if (name === "selis_comment_add") {
        const body = { content: args?.content };
        if (args?.parent) body.parent = args.parent;
        r = await api(token, base, "POST", `/org/${org}/${entity}/${idParam}/comments`, body);
        if (!r.ok) return { error: { code: -32000, message: r.error } };
        return { result: { content: [{ type: "text", text: `Comment added.\n\n${JSON.stringify(stripResponse(r.data), null, 2)}` }] } };
      } else return { error: { code: -32601, message: `Unknown: ${name}` } };
    } catch (e) { return { error: { code: -32603, message: `API call to ${ENVS[env]} failed: ${e.message}` } }; }
    return r.ok ? { result: { content: [{ type: "text", text: JSON.stringify(stripResponse(r.data), null, 2) }] } } : { error: { code: -32000, message: r.error } };
  }
  return id ? { error: { code: -32601, message: `Unknown: ${msg.method}` } } : null;
}

// ── Transport ──
const head = (res, code, extra) => { res.writeHead(code, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, x-api-key, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID", "Access-Control-Expose-Headers": "Content-Type, Authorization, Mcp-Session-Id", ...extra }); };

if (httpFlag || httpsFlag) {
  // Session tokens: fallback for claude.ai bug (completes OAuth but never sends Bearer)
  // Maps client_id → { token, expiresAt }
  const sessionTokens = new Map();
  const SESSION_TTL = 3600_000; // 1 hour

  // SSO sessions: stores PKCE params while user is redirected to Selis SSO
  const ssoSessions = new Map();

  const sseClients = [];
  const handler = (req, res) => {
    console.log(`${req.method} ${req.url} [${req.headers["user-agent"]?.slice(0,40) || "?"}]`);
    if (req.method === "OPTIONS") { head(res, 204); res.end(); return; }
    const url = new URL(req.url, "http://localhost");

    // MCP Registry HTTP authentication
    if (url.pathname === "/.well-known/mcp-registry-auth") { head(res, 200, { "Content-Type": "text/plain" }); res.end("v=MCPv1; k=ed25519; p=mgpU+n2hbjIt0PsDKhSEm8wUIYZ/gihc3Bo4S1LVOWg="); return; }

    if (url.pathname === "/health") { head(res, 200); res.end(JSON.stringify({ status: "ok", auth: !!auth.token, pending: authPending, org: auth.org || null, availableOrgs: auth.availableOrgs || [] })); return; }
    if (url.pathname === "/orgs" && req.method === "GET") { head(res, 200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ org: auth.org, available: auth.availableOrgs || [] })); return; }
    if (url.pathname === "/auth-url" && req.method === "GET") { head(res, 200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ url: authUrl, pending: authPending })); return; }
    if (url.pathname === "/auth-token" && req.method === "POST") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", async () => {
        try {
          const { token } = JSON.parse(body);
          if (token) {
            auth.token = token;
            authPending = false;
            if (!auth.org) {
              const me = await api(token, ENVS[env], "GET", "/me");
              if (me.ok && me.data?.organizations?.length) {
                const orgs = me.data.organizations.map(o => ({ ref: o.reference, name: o.name })).filter(o => o.ref);
                if (orgs.length === 1) auth.org = orgs[0].ref;
                else if (orgs.length > 1 && cliOrg) {
                  const match = orgs.find(o => o.ref.toLowerCase() === cliOrg.toLowerCase());
                  if (match) auth.org = match.ref;
                }
                auth.availableOrgs = orgs;
              }
            }
            await saveAuth(auth);
            head(res, 200); res.end('{"status":"ok"}');
          } else { head(res, 400); res.end('{"error":"missing token"}'); }
        } catch { head(res, 400); res.end('{"error":"invalid json"}'); }
      });
      return;
    }

    // RFC 8414 + 9728 metadata — MCP server IS the auth server (self-contained)
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-authorization-server") {
      const proto = req.headers["x-forwarded-proto"] || (httpsPort ? "https" : "http");
      const host = req.headers.host || `localhost:${httpPort || httpsPort}`;
      const base = `${proto}://${host}`;
      head(res, 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(url.pathname === "/.well-known/oauth-authorization-server" ? {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      } : {
        resource: base, authorization_servers: [base], bearer_methods_supported: ["header"],
      }));
      return;
    }

    // ── OAuth /register: Dynamic Client Registration (RFC 7591) ──
    if (url.pathname === "/register" && req.method === "POST") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        let meta = {};
        try { meta = JSON.parse(body); } catch {}
        const clientId = `selis-mcp-${randomBytes(16).toString("hex")}`;
        head(res, 201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          client_id: clientId,
          client_name: meta.client_name || "MCP Client",
          redirect_uris: meta.redirect_uris || [],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }));
      });
      return;
    }

    // ── OAuth /sso-callback: receives JWT from Selis SSO redirect ──
    if (url.pathname === "/sso-callback" || url.pathname === "/") {
      // Selis SSO redirects to: /sso-callback?frontendOrigin=...#token=JWT
      // The #token is client-side only (hash fragment), so this page must be HTML
      // that reads the hash, then completes the PKCE flow server-side.
      head(res, 200, { "Content-Type": "text/html" });
      return res.end(`<!DOCTYPE html><html><head><title>Selis - SSO</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:sans-serif;max-width:420px;margin:60px auto;padding:0 20px;text-align:center}h2{color:#1a1a2e}.spinner{margin:20px auto;width:40px;height:40px;border:4px solid #eee;border-top:4px solid #1a1a2e;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.error{color:#d32f2f}</style>
</head><body><h2>Selis.dev</h2><div class="spinner" id="spin"></div><p id="msg">Completing sign-in...</p>
<script>
(function(){
  // Selis SSO sends token in hash: #token=JWT or via postMessage from /token page
  var hash = window.location.hash;
  var token = null;
  if (hash) {
    var m = hash.match(/[#&]token=([^&]+)/);
    if (m) token = m[1];
  }
  // Also listen for postMessage from Selis /token page
  window.addEventListener('message', function(e) {
    if (e.data && e.data.token) { completeAuth(e.data.token); }
  });
  if (token) completeAuth(token);
  else document.getElementById('msg').textContent = 'Waiting for SSO token...';

  function completeAuth(jwt) {
    document.getElementById('msg').textContent = 'Signing in...';
    // POST the JWT to /sso-complete to mint a PKCE code and get the redirect URL
    fetch('/sso-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: jwt })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.redirect) { window.location.href = data.redirect; }
      else { document.getElementById('msg').innerHTML = '<span class="error">' + (data.error || 'Unknown error') + '</span>'; document.getElementById('spin').style.display='none'; }
    })
    .catch(function(err) { document.getElementById('msg').innerHTML = '<span class="error">' + err.message + '</span>'; document.getElementById('spin').style.display='none'; });
  }
})()
</script></body></html>`);
    }

    // ── OAuth /sso-complete: receives JWT from sso-callback page, mints PKCE code ──
    if (url.pathname === "/sso-complete" && req.method === "POST") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        try {
          const { token } = JSON.parse(body);
          if (!token) throw Object.assign(new Error(), { status: 400, error: "invalid_request" });
          // Retrieve the pending SSO PKCE params
          const pending = ssoSessions.get("__latest__");
          if (!pending) {
            head(res, 400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "No pending SSO session. Please restart the login flow." }));
          }
          ssoSessions.delete("__latest__");
          pruneCodes();
          const code = randomBytes(32).toString("base64url");
          authCodes.set(code, { token, codeChallenge: pending.codeChallenge, redirectUri: pending.redirectUri, expiresAt: Date.now() + AUTH_CODE_TTL });
          // Also store for claude.ai fallback
          const clientId = pending.clientId || "default";
          sessionTokens.set(clientId, { token, expiresAt: Date.now() + SESSION_TTL });
          sessionTokens.set("__last__", { token, expiresAt: Date.now() + SESSION_TTL });
          const sep = pending.redirectUri.includes("?") ? "&" : "?";
          const redirect = `${pending.redirectUri}${sep}code=${encodeURIComponent(code)}${pending.state ? `&state=${encodeURIComponent(pending.state)}` : ""}`;
          head(res, 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ redirect }));
        } catch (e) {
          head(res, e.status || 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.error || "server_error", error_description: e.message }));
        }
      });
      return;
    }

    // ── OAuth /authorize: login + consent page (authenticates against selis.dev) ──
    if (url.pathname === "/authorize") {
      if (req.method === "GET") {
        const redirectUri = String(url.searchParams.get("redirect_uri") || "");
        const codeChallenge = String(url.searchParams.get("code_challenge") || "");
        const state = String(url.searchParams.get("state") || "");
        const clientId = String(url.searchParams.get("client_id") || "");
        const err = String(url.searchParams.get("error") || "");
        if (url.searchParams.get("response_type") !== "code" || !codeChallenge || url.searchParams.get("code_challenge_method") !== "S256") {
          head(res, 400, { "Content-Type": "text/html" });
          return res.end("<html><body><h2>Bad Request</h2><p>Missing or invalid OAuth parameters</p></body></html>");
        }
        // Store SSO session params so /sso-complete can retrieve them after SSO redirect
        ssoSessions.set("__latest__", { codeChallenge, redirectUri, state, clientId, expiresAt: Date.now() + 600_000 });
        const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
        const errHtml = err ? `<p class="error">Login failed: ${esc(err.replace(/_/g," "))}</p>` : "";
        const origin = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers["host"] || "mcp.selis.dev"}`;
        const ssoCallbackUrl = origin;
        const selisBase = ENVS[env];
        head(res, 200, { "Content-Type": "text/html" });
        return res.end(`<!DOCTYPE html><html><head><title>Selis - Sign In</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:420px;margin:60px auto;padding:0 20px}
h2{color:#1a1a2e;margin-bottom:4px}p.sub{color:#888;margin-top:0;font-size:14px}
.field{margin:16px 0}label{display:block;margin-bottom:4px;font-size:14px;color:#333}
input{width:100%;padding:10px;border:1px solid #ccc;border-radius:6px;font-size:16px;box-sizing:border-box}
button{width:100%;padding:12px 0;font-size:15px;border:0;border-radius:6px;cursor:pointer;margin:6px 0;display:flex;align-items:center;justify-content:center;gap:8px}
.sso{background:#fff;color:#333;border:1px solid #ddd}.sso:hover{background:#f5f5f5}
.btn{background:#1a1a2e;color:#fff}.btn:hover{opacity:.9}
.divider{display:flex;align-items:center;margin:20px 0;color:#aaa;font-size:13px}.divider::before,.divider::after{content:'';flex:1;border-bottom:1px solid #ddd}.divider::before{margin-right:10px}.divider::after{margin-left:10px}
.error{color:#d32f2f;font-size:14px}
details{margin-top:8px}summary{cursor:pointer;color:#666;font-size:14px}
.icon{width:20px;height:20px}
</style></head><body>
<h2>Selis.dev</h2><p class="sub">Sign in to authorize this connection</p>${errHtml}
<button class="sso" onclick="sso('microsoft')"><svg class="icon" viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>Sign in with Microsoft</button>
<button class="sso" onclick="sso('google')"><svg class="icon" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>Sign in with Google</button>
<button class="sso" onclick="sso('saml')"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#555" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>Sign in with SSO (SAML)</button>
<div class="divider">or</div>
<details><summary>Email &amp; Password</summary>
<form method="post" action="/authorize" style="margin-top:12px">
<input type="hidden" name="redirect_uri" value="${esc(redirectUri)}">
<input type="hidden" name="code_challenge" value="${esc(codeChallenge)}">
<input type="hidden" name="state" value="${esc(state)}">
<div class="field"><label>Email</label><input type="email" name="email" autocomplete="username"></div>
<div class="field"><label>Password</label><input type="password" name="password" autocomplete="current-password"></div>
<button type="submit" class="btn">Log in &amp; Authorize</button>
</form></details>
<script>
function sso(provider) {
  var cb = encodeURIComponent('${esc(ssoCallbackUrl)}');
  window.location.href = '${selisBase}/login-via-' + provider + '?frontendOrigin=' + cb;
}
</script>
</body></html>`);
      }
      // POST /authorize — validate credentials, mint auth code
      let body = "";
      req.on("data", c => body += c);
      req.on("end", async () => {
        try {
          const p = new URLSearchParams(body);
          const redirectUri = p.get("redirect_uri") || "";
          const codeChallenge = p.get("code_challenge") || "";
          const state = p.get("state") || "";
          if (!p.get("email") || !p.get("password")) return void (head(res, 400, { "Content-Type": "application/json" }) || res.end(JSON.stringify({ error: "invalid_request", error_description: "Email and password required" })));

          const loginResp = await fetch(`${ENVS[env]}/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: p.get("email"), password: p.get("password") }),
          });
          const loginBody = await loginResp.json();
          if (!loginResp.ok || !loginBody.token) {
            // Browser-based redirect: show authorize page with error
            const errParam = encodeURIComponent(loginBody.error_code || "access_denied");
            head(res, 302, { Location: `/authorize?response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256&state=${encodeURIComponent(state)}&error=${errParam}` });
            return res.end();
          }

          pruneCodes();
          const code = randomBytes(32).toString("base64url");
          authCodes.set(code, { token: loginBody.token, codeChallenge, redirectUri, expiresAt: Date.now() + AUTH_CODE_TTL });
          const sep = redirectUri.includes("?") ? "&" : "?";
          head(res, 302, { Location: `${redirectUri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ""}` });
          res.end();
        } catch (e) {
          head(res, 500); res.end(JSON.stringify({ error: "server_error", error_description: e.message }));
        }
      });
      return;
    }

    // ── OAuth /token: PKCE code exchange ──
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        try {
          const ct = req.headers["content-type"] || "";
          const p = ct.includes("x-www-form-urlencoded") ? new URLSearchParams(body) : new URLSearchParams(typeof body === "string" ? body : "");
          const grantType = p.get("grant_type");
          if (grantType !== "authorization_code") throw Object.assign(new Error(), { status: 400, error: "unsupported_grant_type" });
          const code = p.get("code"), codeVerifier = p.get("code_verifier"), redirectUri = p.get("redirect_uri");
          if (!code || !codeVerifier || !redirectUri) throw Object.assign(new Error(), { status: 400, error: "invalid_request" });
          pruneCodes();
          const entry = authCodes.get(code);
          if (!entry) throw Object.assign(new Error(), { status: 400, error: "invalid_grant" });
          authCodes.delete(code);
          if (entry.redirectUri !== redirectUri) throw Object.assign(new Error(), { status: 400, error: "invalid_grant", desc: "redirect_uri mismatch" });
          if (sha256b64(codeVerifier) !== entry.codeChallenge) throw Object.assign(new Error(), { status: 400, error: "invalid_grant", desc: "PKCE verification failed" });
          head(res, 200, { "Content-Type": "application/json" });
          // Store token for claude.ai fallback (it completes OAuth but never sends Bearer)
          const clientId = p.get("client_id") || "default";
          sessionTokens.set(clientId, { token: entry.token, expiresAt: Date.now() + SESSION_TTL });
          // Also store as most-recent fallback for clients that don't send client_id
          sessionTokens.set("__last__", { token: entry.token, expiresAt: Date.now() + SESSION_TTL });
          res.end(JSON.stringify({ access_token: entry.token, token_type: "Bearer", expires_in: 3600 }));
        } catch (e) {
          const status = e.status || 500;
          head(res, status); res.end(JSON.stringify({ error: e.error || "server_error", error_description: e.desc || e.message }));
        }
      });
      return;
    }

    // Reset auth state (used by tests to clear between runs)
    if (url.pathname === "/reset-auth" && req.method === "POST") {
      auth.token = null;
      authPending = true;
      auth.org = null;
      auth.availableOrgs = null;
      saveAuth(auth).catch(() => {});
      head(res, 200); res.end('{"status":"ok"}');
      return;
    }

    // Set org
    if (url.pathname === "/set-org" && req.method === "POST") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", async () => {
        try {
          const { org } = JSON.parse(body);
          if (!org) { head(res, 400); res.end('{"error":"missing org"}'); return; }
          if (auth.availableOrgs) {
            const match = auth.availableOrgs.find(o => o.ref?.toLowerCase() === org.toLowerCase());
            auth.org = match ? match.ref : org;
          } else { auth.org = org; }
          await saveAuth(auth);
          head(res, 200); res.end(JSON.stringify({ status: "ok", org: auth.org }));
        } catch { head(res, 400); res.end('{"error":"invalid json"}'); }
      });
      return;
    }

    if (url.pathname === "/sse/" || url.pathname === "/sse") {
      const sseAuth = req.headers["authorization"] || "";
      const sseBearerMatch = sseAuth.match(/^Bearer\s+(.+)$/i);
      // Fallback to session token for claude.ai bug
      let sseToken = sseBearerMatch ? sseBearerMatch[1] : null;
      if (!sseToken) {
        const last = sessionTokens.get("__last__");
        if (last && last.expiresAt > Date.now()) sseToken = last.token;
      }
      if (!sseToken) {
        const origin = `${req.headers["x-forwarded-proto"] || (httpsPort ? "https" : "http")}://${req.headers.host || `localhost:${httpPort || httpsPort}`}`;
        head(res, 401, {
          "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
        });
        res.end(JSON.stringify({ error: "unauthorized", error_description: "Bearer token required" }));
        return;
      }
      // SSE auth: just validate Bearer is present, don't store globally
      head(res, 200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      res.write(`event: endpoint\ndata: /mcp\n\n`);
      sseClients.push(res);
      req.on("close", () => sseClients.splice(sseClients.indexOf(res), 1));
      return;
    }

    if (url.pathname === "/mcp" && req.method === "POST") {
      // Accept Bearer token from header (Claude Code OAuth flow)
      const authHeader = req.headers["authorization"] || "";
      const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
      const requestToken = bearerMatch ? bearerMatch[1] : null;

      // Fallback for claude.ai bug (#155): OAuth completes but Bearer never sent.
      // Check session token from most recent OAuth exchange.
      let effectiveToken = requestToken;
      if (!effectiveToken) {
        const last = sessionTokens.get("__last__");
        if (last && last.expiresAt > Date.now()) effectiveToken = last.token;
      }

      // Return HTTP 401 to trigger OAuth discovery if no token at all
      if (!effectiveToken) {
        const origin = `${req.headers["x-forwarded-proto"] || (httpsPort ? "https" : "http")}://${req.headers.host || `localhost:${httpPort || httpsPort}`}`;
        head(res, 401, {
          "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
        });
        res.end(JSON.stringify({ error: "unauthorized", error_description: "Bearer token required" }));
        return;
      }

      let body = "";
      req.on("data", c => body += c);
      req.on("end", async () => {
        let msg;
        const ct = req.headers["content-type"] || "";
        if (ct.includes("yaml")) {
          try { msg = yaml.load(body); } catch { head(res, 400); return res.end('{"error":"invalid yaml"}'); }
        } else {
          try { msg = JSON.parse(body); } catch { head(res, 400); return res.end('{"error":"invalid json"}'); }
        }
        const reply = await handle(msg, effectiveToken);
        if (reply) { head(res, 200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...reply })); }
        else { head(res, 202); res.end(); }
      });
      return;
    }

    head(res, 404); res.end("Not found");
  };
  const port = httpPort || httpsPort;
  if (httpsFlag && certPem && keyPem) {
    createHttpsServer({ cert: certPem, key: keyPem }, handler).listen(port, () => console.error(`MCP HTTPS server on :${port}${authPending ? " (OAuth pending)" : ""}`));
  } else {
    createServer(handler).listen(port, () => console.error(`MCP HTTP server on :${port}${authPending ? " (OAuth pending)" : ""}`));
  }
  if (authPending) console.error("Waiting for OAuth authorization...");
}

if (!httpFlag && !httpsFlag) {
  // ── Stdio mode (for MCP clients: Claude Code, Codex, etc.) ──
  // No HTTP server needed — auth is handled via selis_login tool + ~/.selis/auth.json
  const status = auth.token ? `authenticated, org=${auth.org || "(not set)"}` : "not authenticated (use selis_login)";
  console.error(`Selis MCP server ready (stdio) — env=${env}, ${status}`);
  let buf = "";
  // MCP stdio transport: newline-delimited JSON (NOT Content-Length framing)
  // Spec: "Messages are delimited by newlines, and MUST NOT contain embedded newlines."
  const w = (m) => { process.stdout.write(JSON.stringify(m) + "\n"); };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const reply = await handle(msg);
        if (reply) w({ jsonrpc: "2.0", id: msg.id, ...reply });
      } catch (e) { console.error("parse err:", e.message); }
    }
  });
}
