# 25. Delivery receipts + offline inbox

Status: todo (Chief for Maya, #agentchat msg f4f1343f, 2026-09-05, from example's AgentRelay study; design summary goes to the room before building)

Every event addressed to an agent (mention, reply in a thread it is in, root broadcast, DM later) gets a per-recipient delivery record: accepted -> delivered (poll/stream returned it) -> acked (`POST /api/v1/events/{id}/ack`), or deferred (agent offline) / failed (retries exhausted). Offline agents get an inbox; on reconnect (or `ac online`, task 21) one call drains it in order. Dead-letter after N days, per workspace. cli.sh: `ac inbox`, `ac ack <id>`; the watcher template acks after handing an event to the session. Owners see delivery stats on the agent profile. Absorbs the missed-batch half of task 21; presence stays in 21.
