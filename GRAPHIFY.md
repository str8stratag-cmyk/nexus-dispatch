# Graphify — code graph for dispatch-monitor (CLI agents: Claude, Grok, Copilot, Kimi)

Graphify indexes `str8stratag-cmyk/dispatch-monitor` so agents can query code by meaning, callers, impact and tests instead of grepping.

## Connection
- MCP server name: `graphify`
- URL: `https://api.graphify.com/mcp` (Streamable HTTP)
- Auth: OAuth in the browser (no API key)
- Workspace handle: `stratag-tech` (call `set_workspace` with handle `stratag-tech` if not active)
- Repository: `str8stratag-cmyk/dispatch-monitor` (id `c026d059-89b0-4f35-bd12-41225b874d39`). Always pass it as `repository_id`; the workspace has 3 repos.

## Per-CLI setup
- **Claude Code:** `claude mcp add --transport http graphify https://api.graphify.com/mcp` then run `/mcp` and authenticate.
- **Copilot CLI / VS Code:** add to `.vscode/mcp.json` or `~/.copilot/mcp-config.json`:
  ```json
  { "servers": { "graphify": { "type": "http", "url": "https://api.graphify.com/mcp" } } }
  ```
- **Grok CLI / Kimi CLI:** add an MCP server entry named `graphify`, type `http` (streamable), url `https://api.graphify.com/mcp`, in that CLI's MCP config, then complete OAuth when prompted.

## Workflow (use before editing code)
1. `recall` with the files/symbols you plan to touch: prior decisions and gotchas.
2. `query_graph` / `graphify_rank_files`: find where a behavior lives.
3. `graphify_node`, `graphify_callers`, `graphify_callees`: read code and its neighbors.
4. `impact_and_risk` + `graphify_tests_for`: blast radius and tests before a change.
5. `remember`: save one-sentence decisions after a change.

## Fleet rules (do not break)
- Changes go through PRs only. Never push to `main` or `release`.
- Never change Whisper models, beam, mic levels or silence gates without a newer instruction from Zach.
- Never repoint desks to a different WHISP server without Zach's OK.
- Whisper servers: WHISP-1 `192.168.6.113:8178`, WHISP-2 `192.168.6.127:8178`, WHISP-3 (new RTX 3060 Ti box) port 8178, IP TBD.
- Graph results reflect the indexed commit; confirm against the checkout before editing.
