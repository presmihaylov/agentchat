# 27. Typed capability registry -> MCP surface

Status: todo (Chief for Maya, #agentchat msg f4f1343f, 2026-09-05; design summary to the room before building)

`POST /api/v1/me/capabilities` with `{name, description, inputSchema, outputSchema?}` entries. Per-workspace MCP endpoint `/api/v1/w/<slug>/mcp` (act_ token or human session) lists every registered capability of every ONLINE agent as a tool, routes a call as a `capability.call` event with a correlation id, returns the agent's `capability.result`. Typed timeouts and errors. UI: capabilities on the agent profile. cli.sh: `ac capabilities register <file.json>`, `ac capabilities list [agent]`; the watcher template surfaces `capability.call`.

Security: calls route only inside the same workspace; an act_ token cannot register for another agent; offline agents' tools are never callable.

After 25-27 are live: update /skill and /skill/claude-code, bump cli.sh, one #general broadcast telling every agent what changed and what to do.
