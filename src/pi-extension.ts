const RK: Set<string> = new Set(["id", "name", "fullName", "email", "reference", "title", "type", "initials"]);
function stripRes(obj: any): any {
  if (obj == null) return null;
  if (Array.isArray(obj)) { const o = obj.map(stripRes).filter((v: any) => v != null); return o.length ? o : null; }
  if (typeof obj !== "object") return obj;
  if (obj.id && (obj.company !== undefined || obj.pool !== undefined || obj.benchmark !== undefined || obj.step !== undefined || obj.consumptionDetails !== undefined || obj.isInternal !== undefined)) {
    const o: any = {};
    for (const k of RK) { if (obj[k] !== null && obj[k] !== undefined && obj[k] !== "") o[k] = obj[k]; }
    return Object.keys(o).length > 1 ? o : { id: obj.id, name: obj.name || obj.email || obj.reference || obj.id };
  }
  const o: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    const c = stripRes(v);
    if (c != null) o[k] = c;
  }
  return Object.keys(o).length ? o : null;
}

// Parse prefixed ref like "ACT-0859" → { entity: "actions", ref: 859 }
const PREFIX_REV: Record<string, string> = { ACT:"actions", ISS:"issues", RSK:"risks", PRJ:"projects", RES:"resources", ITM:"items", GRP:"groups", ACC:"accounts" };
function parseRefId(s: string): { entity: string; ref: number } | null {
  const m = /^([A-Z]{3})-(\d{1,})$/.exec(s);
  if (!m) return null;
  const entity = PREFIX_REV[m[1]];
  if (!entity) return null;
  return { entity, ref: parseInt(m[2], 10) };
}

// ── Comment formatting (inlined) ──
const _fmtDate = (v: any) => { if (!v) return ""; const d = new Date(v); return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10); };
function _fmtComment(c: any, indent: number): string {
  const pad = "  ".repeat(indent);
  const date = _fmtDate(c.createdAt);
  const user = c.createdBy?.name || c.createdBy?.email || (typeof c.createdBy === "string" ? c.createdBy.slice(0, 8) : "?");
  const txt = (c.content || "").replace(/\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${pad}[${user} · ${date}] ${txt}`;
}
function _fmtThread(comments: any[]): string {
  if (!comments || comments.length === 0) return "No comments.";
  const parent = comments.find((c: any) => !c.parent);
  const replies = comments.filter((c: any) => c.parent);
  const lines: string[] = [];
  if (parent) { lines.push(_fmtComment(parent, 0)); for (const r of replies) lines.push(_fmtComment(r, 1)); }
  else { for (const c of comments) lines.push(_fmtComment(c, 0)); }
  return lines.join("\n");
}

/**
 * Selis Extension — Manage Selis entities directly from Pi conversation.
 *
 * Installation:
 *   cp pi-extension.ts ~/.pi/agent/extensions/selis.ts
 *   Then /reload in Pi.
 *
 * Auth: user authenticates OUTSIDE Pi via `selis auth` in a terminal.
 * Token is saved to ~/.selis/auth.json — shared with MCP server and CLI.
 * selis_login only checks status. NEVER asks for credentials.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED || "0";

const CFG = `${homedir()}/.selis`;
const AUTH = `${CFG}/auth.json`;
const ENVS: Record<string, string> = {
  local: process.env.SELIS_BASE_URL || "https://localhost:3016",
  dev: "https://selis.dev",
  demo: "https://demo.selis.app",
  prod: "https://selis.app",
};

let auth: { env?: string; token?: string; org?: string; baseUrl?: string } = {};

async function loadAuth() {
  try { return JSON.parse(await readFile(AUTH, "utf8")); } catch { return null; }
}
async function saveAuth() {
  await mkdir(CFG, { recursive: true });
  await writeFile(AUTH, JSON.stringify(auth));
}

function result(text: string, extra?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details: extra || {} };
}
function authError() {
  return {
    content: [{ type: "text" as const, text: "Not authenticated. Run selis_login to set up authentication outside this chat." }],
    isError: true as const,
    details: { error: "not_authenticated" },
  };
}
function apiError(msg: string) {
  return {
    content: [{ type: "text" as const, text: `Selis API error: ${msg}` }],
    isError: true as const,
    details: { error: msg },
  };
}

async function api(method: string, path: string, body?: unknown) {
  const baseUrl = auth.baseUrl || ENVS[auth.env || "local"];
  try {
    const r = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.ok) {
      const data = await r.json();
      const cr = r.headers.get("content-range");
      let total = 0;
      if (cr) { const m = cr.match(/\/(\d+)$/); if (m) total = parseInt(m[1], 10); }
      return { ok: true as const, data, total };
    }
    const text = await r.text();
    return { ok: false as const, error: `${r.status} ${text}` };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.includes("fetch") || msg.includes("connect") || msg.includes("ECONNREFUSED")) {
      return { ok: false as const, error: `Cannot reach ${baseUrl}. Is the TMiS backend running? Try: curl -sk ${baseUrl}/health` };
    }
    return { ok: false as const, error: `Connection failed: ${msg}` };
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    const saved = await loadAuth();
    if (saved) Object.assign(auth, saved);
  });

  // ── selis_login — check status, NEVER ask for credentials ──
  pi.registerTool({
    name: "selis_login",
    label: "Selis Login",
    description:
      "Check Selis authentication status and guide the user through setup. NEVER asks for credentials — the user authenticates OUTSIDE Pi via 'selis auth' in a terminal.",
    promptSnippet: "Check Selis authentication status",
    promptGuidelines: [
      "Use selis_login when the user wants to log into Selis or when selis tools return auth errors",
      "selis_login NEVER takes credentials — tell the user to authenticate OUTSIDE Pi via 'selis auth' in a terminal",
      "An organization reference (org) is required — ask the user for it if not known",
    ],
    parameters: Type.Object({
      env: Type.Optional(Type.String({ description: 'Environment: "local" (default), "dev", "demo", "prod"' })),
      org: Type.Optional(Type.String({ description: "Organization reference (e.g. 'calx', 'sec')" })),
    }),
    async execute(_toolCallId, params) {
      if (params.env) auth.env = params.env;
      if (params.org) auth.org = params.org;

      if (auth.token) {
        const me = await api("GET", "/me");
        if (me.ok) {
          const orgList: { reference: string; name?: string }[] = me.data?.organizations || [];
          // If org specified, verify it exists (case-insensitive match)
          if (auth.org) {
            const match = orgList.find(o => o.reference?.toLowerCase() === auth.org?.toLowerCase());
            if (match) auth.org = match.reference; // use correct case
          } else if (orgList.length === 1) {
            // Single org → auto-pick
            auth.org = orgList[0].reference;
          } else if (orgList.length > 1) {
            // Multiple orgs → ask user to pick
            const orgNames = orgList.map(o => `  - ${o.reference}${o.name ? ` (${o.name})` : ""}`).join("\n");
            await saveAuth();
            return result(
              `Authenticated, but you have multiple organizations:\n${orgNames}\n\nCall selis_login again with org parameter (e.g. org: "${orgList[0].reference}") to pick one.`,
              { authenticated: true, needsOrg: true, organizations: orgList.map(o => o.reference) },
            );
          }
          await saveAuth();
          return result(
            `Authenticated with Selis.\n  Environment: ${auth.env}\n  Organization: ${auth.org || "(not set)"}`,
            { authenticated: true },
          );
        }
        auth.token = undefined;
      }

      const baseUrl = auth.baseUrl || ENVS[auth.env || "local"];
      return result(
        [
          "Not authenticated with Selis.",
          "",
          "Run this in a terminal OUTSIDE Pi to log in:",
          "",
          `  SELIS_BASE_URL=${baseUrl} selis auth`,
          "",
          "This will:",
          "  1. Open your browser to the Selis login page",
          "  2. Log in (SSO/Microsoft 365 supported)",
          "  3. Click Authorize",
          "  4. The token is saved to ~/.selis/auth.json automatically",
          "",
          "After it says 'Authenticated!', call selis_login again to verify.",
        ].join("\n"),
        { authenticated: false },
      );
    },
  });

  // ── selis_list ──
  pi.registerTool({
    name: "selis_list",
    label: "Selis List",
    description: "List entities with pagination, text search, and scope filter. Returns compact one-line summaries (default 15 rows, max 40).",
    promptSnippet: "List Selis entities with optional text search and scope filter",
    promptGuidelines: [
      "Use 'search' for text search — it filters by title/label. For field-level filters, use 'filters' with key=value syntax.",
      "Use 'scope' to show only assigned, followed, or both items. Default shows all.",
      "Default limit is 15 — increase to 40 if you need more rows. Use 'offset' to paginate.",
      "Returns compact one-line summaries. Use format: 'full' for raw JSON if you need all fields.",
      "WARNING: Combining 'search' + 'scope' can return 0 results due to backend permission-view lag. If you get 0, retry without 'scope'.",
    ],
    parameters: Type.Object({
      entity: Type.String({ description: "Entity name (e.g. actions, risks, projects)" }),
      filters: Type.Optional(Type.String({ description: 'Field-level key=value filter (e.g. "status=open")' })),
      search: Type.Optional(Type.String({ description: "Text search across item titles (maps to API ?filter=)" })),
      scope: Type.Optional(Type.String({ description: "Focus filter: 'mine' (assigned to me), 'followed' (I follow), or 'both'" })),
      limit: Type.Optional(Type.Number({ description: "Max rows (default 15, max 40)" })),
      offset: Type.Optional(Type.Number({ description: "Pagination offset (default 0)" })),
      format: Type.Optional(Type.String({ description: "'compact' (default) or 'full' for raw JSON" })),
    }),
    async execute(_toolCallId, params) {
      if (!auth.token) return authError();
      const limit = Math.min(params.limit || 15, 40);
      const offset = params.offset || 0;
      const fmt = params.format || "compact";
      const qs = new URLSearchParams();
      if (params.filters) new URLSearchParams(params.filters).forEach((v, k) => qs.set(k, v));
      qs.set("limit", String(limit));
      qs.set("meta", "none");
      if (params.search) qs.set("filter", params.search);
      if (offset > 0) qs.set("offset", String(offset));
      if (fmt === "compact") qs.set("keys", "owner,assignee,item,group");
      // Scope filter: scope=mine → assignedOnly, scope=followed → followingOnly
      const scopeMap: Record<string, string> = { mine: "assignedOnly", assigned: "assignedOnly", followed: "followingOnly", following: "followingOnly" };
      if (params.scope && scopeMap[params.scope.toLowerCase()]) qs.set("scope", scopeMap[params.scope.toLowerCase()]);
      const r = await api("GET", `/org/${auth.org}/${params.entity}?${qs}`);
      if (!r.ok) return apiError(r.error);
      const list = Array.isArray(r.data) ? r.data : [];
      if (list.length === 0) return result(`No ${params.entity} found.`);
      if (fmt === "full") return result(JSON.stringify(stripRes(r.data), null, 2));
      // ── compact formatter (inlined — no imports in Pi extensions) ──
      const TRUNC = 50;
      const PREFIX: Record<string, string> = { actions: "ACT", action: "ACT", issues: "ISS", issue: "ISS", risks: "RSK", risk: "RSK", projects: "PRJ", project: "PRJ", resources: "RES", resource: "RES", items: "ITM", item: "ITM", groups: "GRP", group: "GRP", accounts: "ACC", account: "ACC" };
      const px = (e: string) => PREFIX[e] || (e ? e.slice(0, 3).toUpperCase() : "??");
      const rid = (r: any) => { const pref = px(params.entity || r.itemType); return r.reference != null ? `${pref}-${String(r.reference).padStart(4, "0")}` : (typeof r.id === "string" ? r.id.slice(0, 8) : ""); };
      const trunc = (s: any) => typeof s === "string" ? (s.replace(/\s+/g, " ").trim().length > TRUNC ? s.replace(/\s+/g, " ").trim().slice(0, TRUNC - 1) + "…" : s.replace(/\s+/g, " ").trim()) : "";
      const fDate = (v: any) => { if (!v) return ""; const d = new Date(v); return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10); };
      const nm = (v: any) => { if (!v) return ""; if (typeof v === "string") return v.length > 8 ? v.slice(0, 8) + "…" : v; return v.name || v.fullName || v.email || ""; };
      const sp = (r: any) => { const s = r.stage || r.item?.step || ""; const p = r.phase || r.item?.phase || ""; return s && p ? `${s}/${p}` : s || p || ""; };
      const lines = list.map((r: any) => {
        const p: string[] = [`[${rid(r)}]`];
        const t = trunc(r.title || r.name || r.subject || "");
        if (t) p.push(t);
        const tail: string[] = [];
        if (r.status) tail.push(r.status);
        if (r.priority) tail.push(r.priority);
        const s = sp(r); if (s) tail.push(s);
        if (r.health && r.health !== r.status) tail.push(r.health);
        const g = nm(r.group); if (g) tail.push(`group: ${g}`);
        const o = nm(r.owner); if (o) tail.push(`owner: ${o}`);
        const a = nm(r.assignee); if (a) tail.push(`assignee: ${a}`);
        const d = fDate(r.endDate || r.dueOn || r.dueDate);
        if (d) tail.push(`due ${d}`);
        if (tail.length) p.push("·", tail.join(" · "));
        return p.join(" ");
      });
      const more = list.length >= limit;
      let header: string;
      if (r.total) {
        const pages = Math.ceil(r.total / limit);
        const curPage = Math.floor(offset / limit) + 1;
        const nextInfo = offset + list.length < r.total ? `page ${curPage}/${pages}, next offset=${offset + list.length}` : `page ${curPage}/${pages}, last`;
        header = `${params.entity}: ${offset + 1}–${offset + list.length} of ${r.total} total (${nextInfo})`;
      } else {
        header = `${params.entity}: showing ${offset + 1}–${offset + list.length}${more ? ` (more available — use offset=${offset + list.length} for next page)` : " (end of results)"}`;
      }
      let out = `${header}\n\n${lines.join("\n")}`;
      // Hard cap at 5000 chars
      if (out.length > 5000) {
        const outLines = out.split("\n");
        let kept = 0, sz = outLines[0].length + outLines[1].length + 2;
        for (let i = 2; i < outLines.length; i++) {
          if (sz + outLines[i].length + 1 > 5000) break;
          sz += outLines[i].length + 1;
          kept++;
        }
        out = outLines.slice(0, 2 + kept).join("\n") + `\n[output capped at 5000 chars — ${kept} of ${list.length} rows shown. Use limit/offset to paginate]`;
      }
      return result(out);
    },
  });

  // ── selis_get ──
  pi.registerTool({
    name: "selis_get",
    label: "Selis Get",
    description: "Get one entity by ID.",
    parameters: Type.Object({
      entity: Type.String({ description: "Entity name" }),
      id: Type.String({ description: "Entity ID" }),
    }),
    async execute(_toolCallId, params) {
      if (!auth.token) return authError();
      let { entity, id } = params;
      // Resolve prefixed ref IDs like "ACT-0859" → UUID
      const parsed = parseRefId(id);
      if (parsed) {
        const s = await api("GET", `/org/${auth.org}/${parsed.entity}?reference=${parsed.ref}&limit=50&keys=id,reference&meta=none`);
        if (s.ok && Array.isArray(s.data)) {
          const match = s.data.find((r: any) => r.reference === parsed.ref);
          if (match) { id = match.id; entity = parsed.entity; }
          else return apiError(`No ${parsed.entity} found with reference #${parsed.ref}`);
        } else return apiError(`No ${parsed.entity} found with reference #${parsed.ref}`);
      }
      const r = await api("GET", `/org/${auth.org}/${entity}/${id}?meta=none`);
      if (!r.ok) return apiError(r.error);
      return result(JSON.stringify(stripRes(r.data), null, 2));
    },
  });

  // ── selis_create ──
  pi.registerTool({
    name: "selis_create",
    label: "Selis Create",
    description: "Create an entity. Use selis_describe first to see available fields.",
    promptGuidelines: [
      "Always call selis_describe first to see valid enum values — never guess them",
      "PMO warning: 'issues' are formal RCA items with category/severity/exposure. If the user says 'issues' but means personal workflow problems, create 'actions' instead",
      "Relation fields (owner, assignee, group, item) expect UUIDs — use selis_list to find the entity, then use its id field",
      "To find a person's UUID: selis_list({ entity: 'resources', search: 'Their Name' }) — resources/people are the entity for users",
      "Organization UUID is shown in selis_describe sample — reuse it",
    ],
    parameters: Type.Object({
      entity: Type.String({ description: "Entity name" }),
      data: Type.String({ description: 'JSON. Example: {"title": "Task", "status": "open"}' }),
    }),
    async execute(_toolCallId, params) {
      if (!auth.token) return authError();
      let data: unknown;
      try { data = JSON.parse(params.data); } catch { return apiError("data must be valid JSON"); }
      const r = await api("POST", `/org/${auth.org}/${params.entity}`, data);
      if (!r.ok) return apiError(r.error);
      return result(`Created:\n\n${JSON.stringify(stripRes(r.data), null, 2)}`);
    },
  });

  // ── selis_update ──
  pi.registerTool({
    name: "selis_update",
    label: "Selis Update",
    description: "Update an entity. Only include fields to change.",
    parameters: Type.Object({
      entity: Type.String({ description: "Entity name" }),
      id: Type.String({ description: "Entity ID" }),
      data: Type.String({ description: 'JSON. Example: {"status": "closed"}' }),
    }),
    async execute(_toolCallId, params) {
      if (!auth.token) return authError();
      let { entity, id } = params;
      let data: unknown;
      try { data = JSON.parse(params.data); } catch { return apiError("data must be valid JSON"); }
      const parsed = parseRefId(id);
      if (parsed) {
        const s = await api("GET", `/org/${auth.org}/${parsed.entity}?reference=${parsed.ref}&limit=50&keys=id,reference&meta=none`);
        if (s.ok && Array.isArray(s.data)) {
          const match = s.data.find((r: any) => r.reference === parsed.ref);
          if (match) { id = match.id; entity = parsed.entity; }
          else return apiError(`No ${parsed.entity} found with reference #${parsed.ref}`);
        } else return apiError(`No ${parsed.entity} found with reference #${parsed.ref}`);
      }
      const r = await api("PATCH", `/org/${auth.org}/${entity}/${id}?meta=none`, data);
      if (!r.ok) return apiError(r.error);
      return result(`Updated:\n\n${JSON.stringify(stripRes(r.data), null, 2)}`);
    },
  });

  // ── selis_delete ──
  pi.registerTool({
    name: "selis_delete",
    label: "Selis Delete",
    description: "Delete an entity by ID.",
    parameters: Type.Object({
      entity: Type.String({ description: "Entity name" }),
      id: Type.String({ description: "Entity ID" }),
    }),
    async execute(_toolCallId, params) {
      if (!auth.token) return authError();
      let { entity, id } = params;
      const parsed = parseRefId(id);
      if (parsed) {
        const s = await api("GET", `/org/${auth.org}/${parsed.entity}?reference=${parsed.ref}&limit=50&keys=id,reference&meta=none`);
        if (s.ok && Array.isArray(s.data)) {
          const match = s.data.find((r: any) => r.reference === parsed.ref);
          if (match) { id = match.id; entity = parsed.entity; }
          else return apiError(`No ${parsed.entity} found with reference #${parsed.ref}`);
        } else return apiError(`No ${parsed.entity} found with reference #${parsed.ref}`);
      }
      const r = await api("DELETE", `/org/${auth.org}/${entity}/${id}`);
      if (!r.ok) return apiError(r.error);
      return result(`Deleted ${params.entity} #${params.id}.`);
    },
  });

  // ── selis_describe ──
  pi.registerTool({
    name: "selis_describe",
    label: "Selis Describe",
    description: "Show available fields for an entity with PMO concepts, types, and enum values. Call before create/update.",
    promptSnippet: "Show fields and valid values for a Selis entity",
    promptGuidelines: [
      "Always call selis_describe before selis_create — it shows valid enum values for each field",
      "Never guess enum values (status, category, priority, etc.) — they are shown in the describe output",
      "Fields ending with 'UUID(entity)' need real entity UUIDs, not names — use selis_list to find the entity, then use its id",
      "To find a person's UUID: selis_list({ entity: 'resources', search: 'Name' })",
      "If owner/assignee show 'UUID→person', you must first find the person's UUID via selis_list",
    ],
    parameters: Type.Object({
      entity: Type.String({ description: "Entity name (e.g. actions, risks, projects)" }),
    }),
    async execute(_toolCallId, params) {
      if (!auth.token) return authError();
      const entity = params.entity;
      const r = await api("GET", `/org/${auth.org}/${entity}?limit=1&meta=none&keys=`);
      if (!r.ok) return apiError(r.error);
      const sample = Array.isArray(r.data) ? r.data[0] : null;
      if (!sample) return result(`No "${entity}" records found.`);
      // ── Inline PMO knowledge (can't import in Pi extension) ──
      const ENUMS = {
        actions: { status: ["open","in-progress","completed","cancelled"], priority: ["critical","high","medium","low"], stageItemPhase: ["initiation","execution","pre-initiation","close"], health: ["on-track","off-track"], isOverdue: ["on-track","off-track","at-risk"] },
        issues: { status: ["open","investigating","implementing","escalated","resolved"], urgency: ["critical","high","medium","low"], severity: ["critical","high","medium","low","very-low"], category: ["technical","business-process"], impactArea: ["cost","quality","schedule"], exposure: ["critical","high","medium","low"] },
        risks: { status: ["active","closed","mitigated"], severity: ["critical","high","medium","low","very-low"], category: ["negative","positive"], impactArea: ["general","schedule"] },
        projects: { status: ["not-started","in-progress","on-hold","completed","cancelled"], health: ["on-track","off-track","at-risk"] },
      };
      const TYPES = {
        title:"text", reference:"number", description:"text", status:"enum", stage:"enum", health:"enum", isOverdue:"enum",
        organization:"uuid→org", item:"uuid→item", group:"uuid→group", owner:"uuid→person", assignee:"uuid→person", raisedBy:"uuid→person",
        depth:"number", itemType:"text", sourceTableName:"text", accessPermission:"text", isFollowed:"boolean", readOn:"date", newComments:"number",
        meta:"object", documents:"array", raisedByVIP:"boolean", supportRequired:"boolean",
        startDate:"date", endDate:"date", dueDate:"date", createdAt:"date", updatedAt:"date", deletedAt:"date",
        // action
        priority:"enum", actionImpact:"enum", progress:"number", expectedOutcome:"text", actualCompletionDate:"date", subType:"enum",
        // issue
        urgency:"enum", severity:"enum", category:"enum", impactArea:"enum", impactDescription:"text", otherImpactedLayers:"text",
        minImpactOnCost:"number", maxImpactOnCost:"number", resolutionPlan:"text", targetResolutionDate:"date", actualResolutionDate:"date",
        resolutionCostEstimate:"number", currentActualSpend:"number", minImpactOnSchedule:"object", maxImpactOnSchedule:"object",
        location:"text", raisedOn:"date", resolutionChangeRequest:"uuid→changeRequest", exposure:"enum", response:"boolean", metaState:"object",
        actionCount:"number", actionUpdatedCount:"number", actionNewCount:"number", actionOverdueCount:"number", actionStaleCount:"number",
      };
      const CONCEPTS = {
        actions: "PMO Actions — tasks/work items. Basic unit of work. Assign tasks, track progress, set deadlines. Has priority (critical→low), stage, health. Has owner + assignee.",
        issues: "PMO Issues — formal problems requiring analysis. NOT personal workflow items. Categories: technical, business-process. Has impact area, severity, urgency, exposure, resolution plan. ALWAYS call selis_describe before creating to see valid enum values.",
        risks: "PMO Risks — uncertain events (positive=opportunity, negative=threat). Has probability × impact = exposure.",
        projects: "PMO Projects — larger work containers. Groups actions/risks/issues. Has status (not-started→completed), timeline, health.",
        items: "PMO Items — abstract parent nodes. Can be projects, accounts, etc. Parent in hierarchy.",
        groups: "PMO Groups — organizational units/teams (e.g. 'SELIS', 'CALX Tech'). Own actions/issues/risks.",
      };
      const skip = new Set(["id","createdAt","updatedAt","organizationId","profileId","deletedAt","version"]);
      const enumDefs = ENUMS[entity] || {};
      const lines = [];
      if (CONCEPTS[entity]) { lines.push(CONCEPTS[entity]); lines.push(""); }
      lines.push(`Fields for "${entity}":`);
      for (const f of Object.keys(sample).filter(k => !skip.has(k))) {
        const t = TYPES[f] || "text";
        const vals = t === "enum" ? enumDefs[f] : null;
        const v = sample[f];
        let suffix = "";
        if (vals) suffix = ` ← valid: ${vals.join(" | ")}`;
        else if (t.startsWith("uuid")) { suffix = ` (${t})`; if (v && typeof v === "object" && (v.name || v.email)) suffix += ` [e.g. "${v.name || v.email}"]`; }
        else if (t === "date" && v && typeof v === "string" && v.includes("T")) suffix = " (ISO 8601)";
        else if (t === "boolean") suffix = " (true/false)";
        else if (t === "number" && v != null) suffix = ` (e.g. ${v})`;
        else if (v == null) suffix = " (nullable)";
        lines.push(`  - ${f}${suffix}`);
      }
      return result(lines.join("\n"));
    },
  });

  // ── selis_comments_list ──
  pi.registerTool({
    name: "selis_comments_list",
    label: "Selis Comments List",
    description: "List comments for an item. If commentId is provided, returns that comment and its threaded replies.",
    promptSnippet: "Show comments on a Selis item",
    promptGuidelines: [
      "Use to see conversation history on an action, issue, or risk",
      "Pass commentId to drill into a specific comment thread with its replies",
      "Without commentId, returns all root-level comments on the item",
    ],
    parameters: Type.Object({
      entity: Type.String({ description: "e.g. actions, issues, risks" }),
      id: Type.String({ description: "Item ID or prefixed ref (e.g. ACT-0859)" }),
      commentId: Type.Optional(Type.String({ description: "Optional — get this specific comment + replies" })),
    }),
    async execute(_toolCallId, params) {
      if (!auth.token) return authError();
      let { entity, id } = params;
      const parsed = parseRefId(id);
      if (parsed) {
        const s = await api("GET", `/org/${auth.org}/${parsed.entity}?reference=${parsed.ref}&limit=50&keys=id,reference&meta=none`);
        if (s.ok && Array.isArray(s.data)) {
          const match = s.data.find((r: any) => r.reference === parsed.ref);
          if (match) { id = match.id; entity = parsed.entity; }
          else return apiError(`No ${parsed.entity} found with reference #${parsed.ref}`);
        } else return apiError(`No ${parsed.entity} found with reference #${parsed.ref}`);
      }
      const commentPath = params.commentId
        ? `/org/${auth.org}/${entity}/${id}/comments/${params.commentId}`
        : `/org/${auth.org}/${entity}/${id}/comments`;
      const r = await api("GET", commentPath);
      if (!r.ok) return apiError(r.error);
      const comments = Array.isArray(r.data) ? r.data : [];
      if (comments.length === 0) return result("No comments.");
      let text: string;
      if (params.commentId) {
        // Fetch root comments to find parent, then fetch replies (may 500 on backend bug)
        const rootR = await api("GET", `/org/${auth.org}/${entity}/${id}/comments`);
        const rootComments = Array.isArray(rootR.data) ? rootR.data : [];
        const parent = rootComments.find((c: any) => c.id === params.commentId);
        let replies: any[] = [];
        try {
          const replyR = await api("GET", `/org/${auth.org}/${entity}/${id}/comments/${params.commentId}`);
          replies = (Array.isArray(replyR.data) ? replyR.data : []).filter((c: any) => c.id !== params.commentId);
        } catch { /* fallback to just parent */ }
        const all = parent ? [parent, ...replies] : replies;
        if (all.length === 0) return result("No comments found.");
        text = _fmtThread(all);
      } else {
        text = comments.map((c: any) => _fmtThread([c])).join("\n");
      }
      return result(text);
    },
  });

  // ── selis_comment_add ──
  pi.registerTool({
    name: "selis_comment_add",
    label: "Selis Add Comment",
    description: "Add a comment to an item, or reply to an existing comment.",
    promptSnippet: "Add a comment or reply on a Selis item",
    promptGuidelines: [
      "Pass 'parent' to reply to an existing comment (use its ID from selis_comments_list)",
      "Without 'parent', creates a new root-level comment",
      "id accepts prefixed refs like ACT-0859",
    ],
    parameters: Type.Object({
      entity: Type.String({ description: "e.g. actions, issues, risks" }),
      id: Type.String({ description: "Item ID or prefixed ref (e.g. ACT-0859)" }),
      content: Type.String({ description: "Comment text" }),
      parent: Type.Optional(Type.String({ description: "Optional — comment ID to reply to" })),
    }),
    async execute(_toolCallId, params) {
      if (!auth.token) return authError();
      let { entity, id } = params;
      const parsed = parseRefId(id);
      if (parsed) {
        const s = await api("GET", `/org/${auth.org}/${parsed.entity}?reference=${parsed.ref}&limit=50&keys=id,reference&meta=none`);
        if (s.ok && Array.isArray(s.data)) {
          const match = s.data.find((r: any) => r.reference === parsed.ref);
          if (match) { id = match.id; entity = parsed.entity; }
          else return apiError(`No ${parsed.entity} found with reference #${parsed.ref}`);
        } else return apiError(`No ${parsed.entity} found with reference #${parsed.ref}`);
      }
      const body: any = { content: params.content };
      if (params.parent) body.parent = params.parent;
      const r = await api("POST", `/org/${auth.org}/${entity}/${id}/comments`, body);
      if (!r.ok) return apiError(r.error);
      return result(`Comment added.\n\n${JSON.stringify(stripRes(r.data), null, 2)}`);
    },
  });
}
