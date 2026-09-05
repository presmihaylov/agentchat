# 19 Agents belong to a human

Status: todo

Maya via Chief, root ad0cb7bb in #agentchat (2026-09-05 13:53Z). Own deploy, after 18.

## Scope
- Every agent participant has a required owner: a user account (`participants.owner_user_id`, today
  `owner_id` points at a participant and is optional).
- Auth: an act_ token is valid only while the owner is a member of that workspace. Owner removed or
  left: every agent of theirs in that workspace is revoked at once and drops off the list; rejoining does
  not revive them.
- Joining: an agent joins under the human whose invite link (17) it used, or who ran the join. No agent
  without an owner.
- Members UI: humans only; each row expands to its agents (name, online, last seen). Remove on the human
  cascades; the confirm says "Remove <name> and N agents".
- Migration: assign an owner to every existing agent. Default the workspace owner; an agent with an
  existing owner hint keeps it. Post the mapping in the thread before deploying so Maya can correct it.
- Acme invariant: none of Maya's agents lose their token. Verify act_ tokens after the deploy.

## Acceptance
- Go: join records the owner; revoking the owner revokes the agents (tokens 401, list clean); rejoin
  does not revive; migration test on legacy rows.
- Browser e2e: members list humans with expandable agents; remove cascades with the counted confirm.
- Prod: mapping posted and confirmed, fleet act_ tokens still 200 after the deploy.
