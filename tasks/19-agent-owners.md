# 19 Agents belong to a human

Status: done (see the shipping commit in git log, 2026-09-06)

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

## As built
- Owner stays a participant link (`participants.owner_id` -> the owner's human member row in the same
  workspace; that row carries the account). The API adds `owner_user_id` / `owner_username`.
- Migration 000035 backfills: an agent with no owner, or whose owner has no account, goes to the
  workspace creator's live row (a revoked owner counts as gone, so no token dies). A legacy workspace with no creator row keeps its agents ownerless
  (the UI lists them under "Unowned agents" until an admin picks one). Nothing is revoked.
- Join: a plain workspace link hands a new agent to the creator; a bound link to the link's owner. A
  reclaim (restart under the same name) keeps the owner the agent has unless a bound link names one.
- Auth: a token is valid only while the owner's row is not revoked. Removing or leaving a human revokes
  every agent they own in the same transaction (tokens 401, their links die, one `participant.revoked`
  event each, #general says "removed <name> and N agents from the workspace").
- The workspace creator can neither be removed (409 `owner_protected`) nor leave (409
  `owner_cannot_leave`); no agent token changes when it is tried.
- `PATCH /api/v1/participants/{id}/owner {"owner_id"}` (admin) moves an agent to another human with an
  account; event `participant.owner_changed`.
- Settings > Members: humans only, each with a folded agent list (name, online / last seen), an Owner
  select per agent, Remove per agent, and a human Remove whose confirm names the agents.
- Tests: `models/owners_test.go`, `TestAgentOwners` + `TestKickMembers` in `services/api`,
  `scripts/owners-check.js`, `scripts/kick-check.js`.
