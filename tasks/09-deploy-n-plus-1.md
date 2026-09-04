# 09 Deploy N+1: NOT NULL and legacy token retirement

Status: todo (blocked: at least 7 days after 04 is on prod, and product questions 2 and 7)

## Scope
- Migration 000029: repair CTE then `rooms.workspace_id SET NOT NULL`.
- Migration 000030: retire legacy human `act_` tokens (question 7).
- Flip `AGENTCHAT_LEGACY_ROOM_CREATE` to false, update skill text and the room-creating scripts (question 2).

## Acceptance
- Suite green with the flag off. Prod: every human still logs in; every agent still online; no watcher gap.
