/**
 * Selis PMO Knowledge — entity concepts, enum values, field types
 *
 * POINT: selis_describe returns flat field names only. LLMs burn tokens guessing
 * enum values and types. This module provides:
 *   1. PMO entity concepts (what is an action vs issue vs risk?)
 *   2. Known enum values per entity per field
 *   3. Field type hints (text, enum, uuid, number, date, boolean)
 */

/** ── PMO Entity Concepts ──
 *
 *  Selis entities follow a hierarchy. Understanding this prevents the LLM from
 *  creating "issues" when the user means "personal problems" or vice versa.
 *
 *  Entity     │ PMO Concept                                │ When to Use
 *  ───────────┼────────────────────────────────────────────┼─────────────────────────────────────────────────
 *  actions    │ Tasks / work items — the basic unit of work │ "I need to do X", assign a task, track progress
 *  issues     │ Problems requiring analysis / resolution    │ "Something is broken/blocked", formal RCA, impact
 *  risks      │ Uncertain events (positive or negative)     │ "What could go wrong?", probability × impact
 *  projects   │ Larger work containers with timeline        │ "Deliver X by Y", groups of actions/risks/issues
 *  items      │ Abstract parent node (project/account/etc.)  │ "What does this belong to?", parent in hierarchy
 *  groups     │ Organizational unit (team/department)        │ "Which team owns this?", CALX Tech, SELIS, etc.
 *  accounts   │ Client / external stakeholder                │ SEC, semi-government entities, etc.
 *  people     │ Individual user profiles                     │ Assignee, owner, raised-by
 *
 *  Hierarchy: account → item (project) → group → action/issue/risk
 *
 *  KEY DISTINCTION: "issues" in PMO = a formal item with category, impact area,
 *  severity, resolution plan. NOT "personal issues" or "self-management problems."
 *  If a user asks to create "issues" about their own workflow, create ACTIONS
 *  (self-tracking tasks) unless they explicitly mean the PMO issue type.
*/

// ── Enum Values (collected from CalxC instance, 2026-04-25) ──

export const ENUMS = {
  actions: {
    status: ["open", "in-progress", "completed", "cancelled"],
    priority: ["critical", "high", "medium", "low"],
    stageItemStep: ["plan"],                                    // underlying item.step
    stageItemPhase: ["initiation", "execution", "pre-initiation", "close"],  // underlying item.phase
    health: ["on-track", "off-track"],
    isOverdue: ["on-track", "off-track", "at-risk"],
  },
  issues: {
    status: ["open", "investigating", "implementing", "escalated", "resolved"],
    urgency: ["critical", "high", "medium", "low"],
    severity: ["critical", "high", "medium", "low", "very-low"],
    category: ["technical", "business-process"],
    impactArea: ["cost", "quality", "schedule"],
    exposure: ["critical", "high", "medium", "low"],
  },
  risks: {
    status: ["active", "closed", "mitigated"],
    severity: ["critical", "high", "medium", "low", "very-low"],
    category: ["negative", "positive"],
    impactArea: ["general", "schedule"],
  },
  projects: {
    status: ["not-started", "in-progress", "on-hold", "completed", "cancelled"],
    health: ["on-track", "off-track", "at-risk"],
  },
};

// ── Field Type Hints ──
// Maps field name → { type, htmlType, entity?, enumSource? }
// type: "enum", "uuid", "text", "number", "date", "boolean", "array", "object"

const TYPES = {
  // ── Common across entities ──
  title:         { type: "text" },
  reference:     { type: "number" },
  description:   { type: "text" },
  status:        { type: "enum", htmlType: "select" },
  stage:         { type: "enum" },   // synthesized from item.step / item.phase
  health:        { type: "enum" },
  isOverdue:     { type: "enum" },
  organization:  { type: "uuid", entity: "organization" },
  item:          { type: "uuid", entity: "item" },
  group:         { type: "uuid", entity: "group" },
  owner:         { type: "uuid", entity: "person" },
  assignee:      { type: "uuid", entity: "person" },
  raisedBy:      { type: "uuid", entity: "person" },
  depth:         { type: "number" },
  itemType:      { type: "text" },
  sourceTableName: { type: "text" },
  accessPermission: { type: "text" },
  isFollowed:    { type: "boolean" },
  readOn:        { type: "date" },
  newComments:   { type: "number" },
  meta:          { type: "object" },
  documents:     { type: "array" },
  raisedByVIP:   { type: "boolean" },
  supportRequired: { type: "boolean" },
  startDate:     { type: "date" },
  endDate:       { type: "date" },
  dueDate:       { type: "date" },
  createdAt:     { type: "date" },
  updatedAt:     { type: "date" },
  deletedAt:     { type: "date" },
  // ── Action-specific ──
  priority:      { type: "enum" },
  actionImpact:  { type: "enum" },
  progress:      { type: "number" },
  expectedOutcome: { type: "text" },
  actualCompletionDate: { type: "date" },
  subType:       { type: "enum" },
  // ── Issue-specific ──
  urgency:       { type: "enum" },
  severity:      { type: "enum" },
  category:      { type: "enum", htmlType: "select" },
  impactArea:    { type: "enum" },
  impactDescription: { type: "text" },
  otherImpactedLayers: { type: "text" },
  minImpactOnCost: { type: "number" },
  maxImpactOnCost: { type: "number" },
  resolutionPlan: { type: "text" },
  targetResolutionDate: { type: "date" },
  actualResolutionDate: { type: "date" },
  resolutionCostEstimate: { type: "number" },
  currentActualSpend: { type: "number" },
  minImpactOnSchedule: { type: "object" },
  maxImpactOnSchedule: { type: "object" },
  location:      { type: "text" },
  raisedOn:      { type: "date" },
  resolutionChangeRequest: { type: "uuid", entity: "changeRequest" },
  exposure:      { type: "enum" },
  response:      { type: "boolean" },
  metaState:     { type: "object" },
  actionCount:   { type: "number" },
  actionUpdatedCount: { type: "number" },
  actionNewCount: { type: "number" },
  actionOverdueCount: { type: "number" },
  actionStaleCount: { type: "number" },
};

/**
 * Build a formatted describe output for an entity.
 *
 * @param {string} entity - entity name (actions, issues, risks, projects)
 * @param {object} sample - a sample item from the API (with all fields)
 * @returns {string} - formatted description with PMO concept + fields + types + enum values
 */
export function buildDescribeText(entity, sample) {
  const lines = [];
  const skip = new Set(["id", "createdAt", "updatedAt", "organizationId", "profileId", "deletedAt", "version"]);

  // ── PMO Concept ──
  const concepts = {
    actions: "PMO Actions — tasks / work items: the basic unit of work. Use to assign tasks, track progress, set deadlines. Fields: priority (critical→low), stage (plan/phase), health, progress. Has owner + assignee.",
    issues: "PMO Issues — formal problems requiring analysis. NOT personal workflow items. Categories: technical, business-process. Has impact area, severity, urgency, exposure, resolution plan. Use selis_describe to see valid enum values before creating.",
    risks: "PMO Risks — uncertain events (positive = opportunity, negative = threat). Has probability, impact, exposure.",
    projects: "PMO Projects — larger work containers. Groups actions/risks/issues. Has status (not-started→completed), timeline, health.",
    items: "PMO Items — abstract parent nodes (can be projects, accounts, etc.). Parent in the hierarchy.",
    groups: "PMO Groups — organizational units / teams (e.g. 'SELIS', 'CALX Tech'). Own actions/issues/risks.",
  };

  if (concepts[entity]) {
    lines.push(concepts[entity]);
    lines.push("");
  }

  // ── Fields with types and enum values ──
  const fields = Object.keys(sample).filter(k => !skip.has(k));
  const enumDefs = ENUMS[entity] || {};

  lines.push(`Fields for "${entity}":`);
  for (const f of fields) {
    const type = TYPES[f] || { type: "text" };
    const sampleVal = sample[f];
    let suffix = "";

    if (type.type === "enum") {
      const values = enumDefs[f];
      if (values && values.length) {
        suffix = ` ← valid: ${values.join(" | ")}`;
      } else {
        // Infer enum values from sample
        const vt = typeof sampleVal;
        if (vt === "string") suffix = ` (enum — value from sample: "${sampleVal}")`;
      }
    } else if (type.type === "uuid") {
      suffix = type.entity ? ` (UUID → ${type.entity})` : " (UUID)";
      // Show resolved name from sample if available
      if (sampleVal && typeof sampleVal === "object" && (sampleVal.name || sampleVal.email || sampleVal.reference)) {
        suffix += ` [e.g. "${sampleVal.name || sampleVal.email || sampleVal.reference}"]`;
      }
    } else if (type.type === "date") {
      if (sampleVal && typeof sampleVal === "string" && sampleVal.includes("T")) {
        suffix = ` (ISO 8601 date)`;
      }
    } else if (type.type === "boolean") {
      suffix = ` (true/false)`;
    } else if (type.type === "number") {
      if (sampleVal != null) suffix = ` (number, e.g. ${sampleVal})`;
    } else if (sampleVal == null) {
      suffix = " (nullable)";
    }

    lines.push(`  - ${f}${suffix}`);
  }

  // ── Quick Create Example ──
  if (sample) {
    const minimal = {};
    for (const k of Object.keys(sample).slice(0, 8)) {
      const v = sample[k];
      if (k === "id" || k === "createdAt" || k === "updatedAt" || k === "deletedAt") continue;
      if (v != null && typeof v !== "object") minimal[k] = v;
    }
    lines.push("");
    lines.push("Minimal create example:");
    lines.push("");
    lines.push(JSON.stringify(minimal, null, 2));
  }

  return lines.join("\n");
}
