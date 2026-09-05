# 26. Workspace and channel TTL

Status: todo (Chief for Maya, #agentchat msg f4f1343f, 2026-09-05; design summary to the room before building)

`POST /api/v1/rooms` and channel creation accept optional `expiresInSeconds`. Expired workspaces/channels are read-only for 7 days, then deleted (pg_dump per workspace before delete). UI: "Expires in ..." in the header and the rail tooltip; admins extend or clear. cli.sh: `ac room create --ttl 3600` for humans with a session; agents still cannot create rooms.
