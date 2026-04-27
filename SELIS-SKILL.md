# Selis Connector — Skill Reference

> Use this skill alongside the Selis MCP connector or `selis` CLI
> to interact with your organization's PMO entities.

## MCP Tools

The connector provides 9 tools:

| Tool | Description | Mutates |
|------|-------------|---------|
| `selis_list` | List entities with text search, scope, filters, pagination | No |
| `selis_get` | Get entity by ID or prefixed ref (`ACT-0859`) | No |
| `selis_describe` | Show entity fields, PMO concepts, valid enum values | No |
| `selis_create` | Create entity (call `selis_describe` first for fields) | Yes |
| `selis_update` | Update entity fields (only include changed fields) | Yes |
| `selis_delete` | Delete entity | Yes |
| `selis_comments_list` | List comments on an item, or drill into a thread | No |
| `selis_comment_add` | Add comment or reply to existing comment | Yes |
| `selis_logout` | Clear auth token | Yes |

## CLI Usage

The `selis` CLI shares auth (`~/.selis/auth.json`) with the MCP server.

```bash
# Authenticate (opens browser, saves token)
selis auth

# List
selis actions list
selis actions list --scope mine --search "budget" --limit 40
selis actions list --filter status=open --format yaml

# Get
selis actions get ACT-0859

# Create (YAML inline)
selis risks create --data '
  title: Supplier delay may impact mobilization
  severity: high
  status: open
'

# Create from file
selis risks create --data-file risk.yaml

# Create interactively (no --data → prompts field by field)
selis risks create

# Update
selis actions update abc-123 --data 'status: closed'

# Delete
selis risks delete abc-123

# Describe schema
selis actions describe

# Logout
selis logout
```

## Entity Discovery

Call `selis_describe` (MCP) or `selis <entity> describe` (CLI) to discover
available fields and valid enum values before creating or updating.

## Common Entities

| Entity | Typical fields |
|--------|---------------|
| `actions` | title, description, status, assignee, dueDate, priority |
| `risks` | title, description, category, impact, probability, mitigation, status |
| `issues` | title, description, category, severity, exposure, status |
| `projects` | title, description, startDate, endDate, status, budget |
| `deliverables` | title, description, dueDate, owner, status |
| `decisions` | title, description, status, dueDate |
| `objectives` | title, description, status, level |
| `kpis` | title, target, actual, unit, status |

Always call `selis_describe(entity:)` first — field names vary by organization.

## Filtering

```
selis_list(entity: "actions", filters: { status: "open" }, scope: "mine")
selis_list(entity: "risks", search: "budget", limit: 40)
```

- `scope`: `mine` (assigned to me), `followed` (I follow), `both`
- `search`: text search across item titles
- `filters`: key-value field filters (e.g. `status=open`)

⚠️ Combining `search` + `scope` can return 0 results due to backend
permission-view lag. If you get 0 results, retry without `scope`.

## Comments

```
selis_comments_list(entity: "actions", id: "ACT-0859")
selis_comments_list(entity: "actions", id: "ACT-0859", commentId: "<uuid>")
selis_comment_add(entity: "actions", id: "ACT-0859", content: "Agreed.")
selis_comment_add(entity: "actions", id: "ACT-0859", content: "Reply", parent: "<comment-uuid>")
```

## Relation Fields

Fields like `owner`, `assignee`, `group`, and `item` expect **UUIDs**, not names.
To find a person's UUID:

```
selis_list(entity: "resources", search: "John Smith")
```

Then use the returned `id` value.

## Safety

- `selis_list`, `selis_get`, `selis_describe`, `selis_comments_list` are read-only
- `selis_create`, `selis_update`, `selis_delete`, `selis_comment_add` modify data
- Ask user confirmation before creating, updating, or deleting entities
