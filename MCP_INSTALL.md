# Selis MCP — Installation & Configuration

> **Registry**: [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io/?q=selis)
> — `app.selis.mcp/pmo` (production) · `dev.selis.mcp/pmo` (development)

---

## Quick Start (npx)

No install needed — run directly:

```bash
SELIS_ENV=dev SELIS_ORG=CalxC npx @calx/selis-mcp
```

Or install globally:

```bash
npm install -g @calx/selis-mcp
```

---

## Step 1 — Authenticate (once)

```bash
# For dev environment
SELIS_ENV=dev selis auth

# For local (self-signed certs)
SELIS_BASE_URL=https://localhost:3016 NODE_TLS_REJECT_UNAUTHORIZED=0 selis auth

# For production
SELIS_ENV=prod selis auth
```

This opens your browser → log in → click **Authorize** → token saved to `~/.selis/auth.json`.

Auth is shared between the MCP server and the CLI.

---

## Step 2 — Configure your MCP client

### Claude Code

Add to `.mcp.json` (project root or `~/.claude/.mcp.json` for global):

```json
{
  "mcpServers": {
    "selis": {
      "command": "npx",
      "args": ["-y", "@calx/selis-mcp"],
      "env": {
        "SELIS_ENV": "dev",
        "SELIS_ORG": "CalxC"
      }
    }
  }
}
```

### Codex (OpenAI)

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.selis]
command = "npx"
args = ["-y", "@calx/selis-mcp"]

[mcp_servers.selis.env]
SELIS_ENV = "dev"
SELIS_ORG = "CalxC"
```

### Cursor

`Cmd+Shift+P` → `MCP: Configure`:

```json
{
  "mcpServers": {
    "selis": {
      "command": "npx",
      "args": ["-y", "@calx/selis-mcp"],
      "env": {
        "SELIS_ENV": "dev",
        "SELIS_ORG": "CalxC"
      }
    }
  }
}
```

### Zed

Add to `~/.config/zed/settings.json`:

```json
{
  "mcp": {
    "servers": {
      "selis": {
        "command": {
          "path": "npx",
          "args": ["-y", "@calx/selis-mcp"],
          "env": {
            "SELIS_ENV": "dev",
            "SELIS_ORG": "CalxC"
          }
        }
      }
    }
  }
}
```

### Local development (from source)

Point directly at the source instead of npx:

```json
{
  "mcpServers": {
    "selis": {
      "command": "node",
      "args": ["<path-to-repo>/app/selis-mcp/src/index.mjs"],
      "env": {
        "SELIS_ENV": "local",
        "SELIS_ORG": "CalxC",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SELIS_ENV` | — | `local`, `dev`, `demo`, or `prod` |
| `SELIS_ORG` | — | Organization reference (e.g. `CalxC`, `selis`) |
| `SELIS_BASE_URL` | env-dependent | Override API base URL |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `0` | Set to `1` to enforce TLS verification |

---

## MCP Tools

| Tool | Description | Read-only |
|------|-------------|-----------|
| `selis_list` | List entities with search, scope, filters, pagination | ✅ |
| `selis_get` | Get entity by ID or prefixed ref (`ACT-0859`) | ✅ |
| `selis_describe` | Show fields, PMO concepts, valid enum values | ✅ |
| `selis_create` | Create entity (call `selis_describe` first) | |
| `selis_update` | Update entity fields | |
| `selis_delete` | Delete entity | |
| `selis_comments_list` | List/thread comments on an item | ✅ |
| `selis_comment_add` | Add comment or reply to existing comment | |
| `selis_logout` | Clear auth token | |

---

## CLI

The `selis` CLI shares auth and features with the MCP server.

```bash
# Authenticate
selis auth

# List (compact output by default)
selis actions list
selis actions list --scope mine --search "budget"
selis actions list --filter status=open --limit 40

# Get
selis actions get ACT-0859

# Create (inline YAML, JSON, or interactive)
selis risks create --data 'title: Supplier delay
severity: high
status: open'

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
selis actions describe --format yaml

# Output formats
selis actions list --format yaml
selis actions list --full           # raw JSON, no compact projection

# Logout
selis logout
```

### CLI Flags

| Flag | Description |
|------|-------------|
| `--env ENV` | Environment: `local`, `dev`, `demo`, `prod` |
| `--org ORG` | Organization reference |
| `--scope SCOPE` | `mine` (assigned), `followed`, or `all` (default) |
| `--search TEXT` | Text search across item titles |
| `--filter K=V` | Field filter (repeatable) |
| `--limit N` | Max rows (default 15, max 40) |
| `--offset N` | Pagination offset |
| `--full` | Raw JSON output for list |
| `--format FMT` | `compact` (default for list), `json`, `yaml` |
| `--data YAML/JSON` | Inline data for create/update |
| `--data-file PATH` | Data file (`.yaml`, `.yml`, `.json`) |

---

## HTTP Mode (debugging & Docker)

```bash
# HTTP with SSE transport
node src/index.mjs dev CalxC --http 3773

# HTTPS (for OAuth redirect)
HTTPS_CERT_FILE=cert.pem HTTPS_KEY_FILE=key.pem \
  node src/index.mjs dev CalxC --https 3774
```

Endpoints:

| Path | Method | Description |
|------|--------|-------------|
| `/mcp` | POST | JSON-RPC tool calls |
| `/sse` | GET | Server-Sent Events stream |
| `/health` | GET | Auth status, org info |
| `/auth-url` | GET | Current OAuth URL |
| `/auth-token` | POST | Receive token from browser callback |
| `/set-org` | POST | Switch organization |
| `/orgs` | GET | List available organizations |
| `/reset-auth` | POST | Clear auth state (testing) |

---

## Docker

```bash
docker build -t selis-mcp .
docker run -p 3773:3773 -e SELIS_ENV=dev selis-mcp
```

---

## Troubleshooting

- **"Not authenticated"** — Run `selis auth` first
- **TLS errors on local** — Set `NODE_TLS_REJECT_UNAUTHORIZED=0`
- **Org not found** — Check case — org references are case-sensitive (`CalxC`, not `calxc`)
- **Auth pending** — Open the URL printed to stderr, log in, click Authorize
- **search + scope returns 0** — Known backend issue. Retry without `--scope`.
