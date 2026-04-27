// Shared compact-list formatter for selis CLI, MCP server, and Pi extension.
// Goal: turn 14KB-per-row API responses into ~120-char-per-row LLM-friendly lines.

const TRUNC_TITLE = 50;
const CHAR_CAP = 5000;

// Fields to keep in relation objects (owner, assignee, group, raisedBy).
// Everything else in a 59-key relation is noise (36/59 keys are null on average).
const RELATION_KEEP = new Set(["id", "name", "fullName", "email", "reference", "title", "type", "initials"]);
// Detect relation objects by their unique fields (resources have company/pool, groups have benchmark, items have step/phase/group)
function isRelationObj(obj) {
  return obj.id && (
    obj.company !== undefined || obj.pool !== undefined || obj.benchmark !== undefined ||
    obj.step !== undefined || obj.consumptionDetails !== undefined || obj.isInternal !== undefined
  );
}

function shortId(id) {
  return typeof id === "string" && id.length > 8 ? id.slice(0, 8) : id || "";
}

export const PREFIX = {
  actions: "ACT", action: "ACT",
  issues: "ISS", issue: "ISS",
  risks: "RSK", risk: "RSK",
  projects: "PRJ", project: "PRJ",
  resources: "RES", resource: "RES",
  items: "ITM", item: "ITM",
  groups: "GRP", group: "GRP",
  accounts: "ACC", account: "ACC",
};
// Reverse: prefix → entity name
export const PREFIX_ENTITY = {};
for (const [k, v] of Object.entries(PREFIX)) { if (!PREFIX_ENTITY[v]) PREFIX_ENTITY[v] = k; }
export function entityPrefix(entity) {
  return PREFIX[entity] || (entity ? entity.slice(0, 3).toUpperCase() : "??");
}
/**
 * Parse a prefixed ref like "ACT-0859" → { entity: "actions", ref: 859 }
 * Returns null if it doesn't look like a prefixed ref.
 */
export function parseRefId(id) {
  const m = /^([A-Z]{3})-(\d{1,})$/.exec(id);
  if (!m) return null;
  const prefix = m[1];
  const ref = parseInt(m[2], 10);
  const entity = PREFIX_ENTITY[prefix];
  if (!entity) return null;
  return { entity, ref };
}
function refId(row, entity) {
  const prefix = entityPrefix(entity || row.itemType);
  const ref = row.reference;
  if (ref != null) return `${prefix}-${String(ref).padStart(4, "0")}`;
  // Fallback: hex ID prefix if no reference
  return shortId(row.id);
}

function truncate(s, max) {
  if (typeof s !== "string") return "";
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fmtDate(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function nameOf(v) {
  if (!v) return "";
  if (typeof v === "string") return v.length > 8 ? v.slice(0, 8) + "…" : v;
  if (typeof v === "object") return v.name || v.fullName || v.email || shortId(v.id);
  return "";
}

function stagePhase(row) {
  const stage = row.stage || row.item?.step || "";
  const phase = row.phase || row.item?.phase || "";
  if (stage && phase) return `${stage}/${phase}`;
  return stage || phase || "";
}

function rowToLine(row, entity) {
  const parts = [];
  const id = refId(row, entity);
  const title = truncate(row.title || row.name || row.subject || "", TRUNC_TITLE);

  parts.push(`[${id}]`);
  if (title) parts.push(title);

  const tail = [];
  if (row.status) tail.push(row.status);
  if (row.priority) tail.push(row.priority);
  const sp = stagePhase(row);
  if (sp) tail.push(sp);
  if (row.health && row.health !== row.status) tail.push(row.health);
  const group = nameOf(row.group);
  if (group) tail.push(`group: ${group}`);
  const owner = nameOf(row.owner);
  if (owner) tail.push(`owner: ${owner}`);
  const assignee = nameOf(row.assignee);
  if (assignee) tail.push(`assignee: ${assignee}`);
  const due = fmtDate(row.endDate || row.dueOn || row.dueDate);
  if (due) tail.push(`due ${due}`);

  if (tail.length) parts.push("·", tail.join(" · "));
  return parts.join(" ");
}

/** Default keys to request from API to get populated relations for compact output. */
export const DEFAULT_LIST_KEYS = "owner,assignee,item,group";

function maybeCap(out, itemCount) {
  if (out.length <= CHAR_CAP) return out;
  const lines = out.split("\n");
  let kept = 0, sz = (lines[0]?.length || 0) + (lines[1]?.length || 0) + 2;
  for (let i = 2; i < lines.length; i++) {
    if (sz + lines[i].length + 1 > CHAR_CAP) break;
    sz += lines[i].length + 1;
    kept++;
  }
  return lines.slice(0, 2 + kept).join("\n")
    + `\n[output capped at ${CHAR_CAP} chars — ${kept} of ${itemCount} rows shown. Use limit/offset to paginate]`;
}

export function compactList(rows, opts = {}) {
  const { entity = "results", offset = 0, limit = 25, total } = opts;
  if (!Array.isArray(rows) || rows.length === 0) return `No ${entity} found.`;

  const lines = rows.map(r => rowToLine(r, entity));
  const start = offset + 1;
  const end = offset + rows.length;
  let pagination = "";
  if (total) {
    if (end < total) {
      const pages = Math.ceil(total / limit);
      const currentPage = Math.floor(offset / limit) + 1;
      pagination = ` (page ${currentPage}/${pages}, next offset=${end})`;
    } else {
      const pages = Math.ceil(total / limit);
      pagination = ` (page ${pages}/${pages}, last)`;
    }
    const header = `${entity}: ${start}-${end} of ${total} total${pagination}`;
    return maybeCap([header, "", ...lines].join("\n"), total);
  }
  const more = rows.length >= limit ? ` (more available — use offset=${end} for next page)` : " (end of results)";
  const header = `${entity}: showing ${start}-${end}${more}`;
  return maybeCap([header, "", ...lines].join("\n"), rows.length);
}

export function compactListAligned(rows, opts = {}) {
  return compactList(rows, opts);
}

/**
 * Strip null values and trim relation objects to only id + label.
 * Turns 12KB single-action responses into ~5KB (57% reduction).
 */
export function stripResponse(obj) {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) {
    const out = obj.map(stripResponse).filter(v => v != null);
    return out.length > 0 ? out : null;
  }
  if (typeof obj !== "object") return obj;
  // Relation object — keep only id + label fields
  if (isRelationObj(obj)) {
    const out = {};
    for (const k of RELATION_KEEP) {
      if (obj[k] !== null && obj[k] !== undefined && obj[k] !== "") out[k] = obj[k];
    }
    return Object.keys(out).length > 1 ? out : { id: obj.id, name: obj.name || obj.email || obj.reference || obj.id };
  }
  // Generic object — recursively strip
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    const cleaned = stripResponse(v);
    if (cleaned !== null && cleaned !== undefined) out[k] = cleaned;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ── Comment formatting ──

/** Format a single comment into a compact line */
export function fmtComment(c, indent = 0) {
  const pad = "  ".repeat(indent);
  const date = fmtDate(c.createdAt);
  const user = c.createdBy?.name || c.createdBy?.email || shortId(c.createdBy);
  const txt = (c.content || "").replace(/\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${pad}[${user} · ${date}] ${txt}`;
}

/** Build a threaded comment tree. Expects [parentComment, ...replyChildren]. */
export function fmtCommentThread(comments) {
  if (!Array.isArray(comments) || comments.length === 0) return "No comments.";
  const parent = comments.find(c => !c.parent);
  const replies = comments.filter(c => c.parent);
  const lines = [];
  if (parent) {
    lines.push(fmtComment(parent, 0));
    for (const reply of replies) lines.push(fmtComment(reply, 1));
  } else {
    // No parent — treat all as top-level
    for (const c of comments) lines.push(fmtComment(c, 0));
  }
  return lines.join("\n");
}
