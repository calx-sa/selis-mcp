# Selis MCP Server & CLI

[![SSPL-1.0](https://img.shields.io/badge/license-SSPL--1.0-blue)](LICENSE)
[![Registry](https://img.shields.io/badge/mcp-registry.modelcontextprotocol.io-8A2BE2)](https://registry.modelcontextprotocol.io/?q=selis)

MCP server for [Selis](https://selis.app) — a comprehensive transformation management platform. Manage PMO entities (actions, risks, issues, projects, deliverables, decisions, KPIs, objectives) from any MCP-compatible agent.

Works with **Claude Code**, **Codex**, **Cursor**, **Zed**, or any MCP client.

## Quick Start

```bash
# Authenticate once
SELIS_ENV=dev SELIS_ORG=CalxC npx @calx/selis-mcp
```

Opens your browser → log in → click Authorize. Token saved to `~/.selis/auth.json`.

### Client Config (`.mcp.json`)

```json
{
  "mcpServers": {
    "selis": {
      "command": "npx",
      "args": ["-y", "@calx/selis-mcp"],
      "env": { "SELIS_ENV": "dev", "SELIS_ORG": "CalxC" }
    }
  }
}
```

## CLI

```bash
selis actions list --scope mine --search "budget"
selis actions get ACT-0859
selis risks create --data 'title: Supplier delay\nseverity: high'
selis actions update abc-123 --data 'status: closed'
```

## Tools

| Tool | Description |
|------|-------------|
| `selis_list` | List entities with search, scope, filters, pagination |
| `selis_get` | Get entity by ID or prefixed ref (`ACT-0859`) |
| `selis_describe` | Show fields, PMO concepts, valid enum values |
| `selis_create` | Create entity |
| `selis_update` | Update entity fields |
| `selis_delete` | Delete entity |
| `selis_comments_list` | List / thread comments on an item |
| `selis_comment_add` | Add comment or reply |

## Deploy

```bash
# Docker
docker build -t selis-mcp .
docker run -p 3773:3773 -e SELIS_ENV=dev selis-mcp

# HTTP mode (debugging)
npx @calx/selis-mcp dev CalxC --http 3773
```

## License

[Server Side Public License v1](LICENSE) — free to use and modify. The SSPL ensures that anyone who offers the functionality as a service must also release the source.
