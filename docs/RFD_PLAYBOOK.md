# RFC/RFD Playbook — Release Paperwork in BC Gov Jira

> **Canonical, assistant-agnostic playbook** for creating release paperwork (RFCs, RFDs, RFD-subtasks) with the RAVEN `jira-mcp` tools. The Claude Code skill ([`.claude/skills/rfd/SKILL.md`](../.claude/skills/rfd/SKILL.md)) and the VS Code Copilot prompt ([`.github/prompts/rfd.prompt.md`](../.github/prompts/rfd.prompt.md)) are thin adapters that point here — edit this file, not the adapters. Tool names below are the RAVEN `jira-mcp` tool names and work from any MCP client.

## Overview

One **RFC** per release per application (the change record). One **RFD** per target environment (the deployment event). **RFD-subtasks** only when a deployment has multiple steps or people. All tickets live in the application's own Jira project.

## What to create

| Release shape | Create |
|---|---|
| Fully automated deployment platform that records its own deploy history, application change only | RFC only (the platform records the deploys) |
| Single-step push-button deploy (one pipeline job does the whole deployment) | RFC + one RFD per environment with Deployment Category set — no subtasks |
| Multi-step or multi-person (DB scripts, infra changes, stop/start) | RFC + RFDs + one RFD-subtask per step: one per DB script, one per infra service; app stop / deploy / restart are separate subtasks |
| Release spans multiple applications, deployments bundled together | RFC per application, with each secondary RFC linked to the primary app's RFC — but only ONE set of RFDs/RFD-subtasks for the whole release (per environment, subtasks covering every app), all linked to the primary app's RFC. Secondary RFCs get no RFDs |

## Recipe

1. Gather: project key, version, target environments, Change Sponsor and Change Coordinator (resolve usernames with `search_users`), planned PROD date, release contents.
2. Duplicate check: `search_issues` for an open RFC with the same project + fix version. Reuse it rather than creating a second.
3. `get_field_meta` for RFC and RFD (and RFD-subtask if needed) in the target project. Required fields and option values vary per project — never guess them, and trust this over any documentation.
4. Fix Version: `list_versions`; `create_version` if missing.
5. Create the RFC (`create_issue` with `customFields`).
6. Create one RFD per environment, then link each: `link_issues` with linkType `RFC-RFD`, outward = the RFC, inward = the RFD.
7. If subtasks are needed: `create_issue` with issueType `RFD-subtask` and `parentKey` = the RFD. Deployment Category routes the work: Application deployment → the application-services team, Database change → the DBA team (link the script's repo path + README, state run order), Infrastructure configuration change → the infrastructure team, Other → a named assignee.
8. Offer to show open deployment slots for the target window (`list_deployment_slots`; `get_deployment_booking` shows an RFD's existing booking). If the user asks you to book, confirm the exact slot, then `reserve_deployment_slot`. Report what remains manual (Submit, approvals — see below) and stop.

## Hard gates

- Confirm with the user before every create/link, showing the full field payload first.
- Do NOT transition tickets (Submit/Approve/Resolve), record client approval, or book deployment slots unless the user explicitly asks for that specific action.
- Deployment booking: view freely (`list_deployment_slots`, `get_deployment_booking`); reserve or cancel (`reserve_deployment_slot`, `cancel_deployment_booking`) only when the user explicitly asks, and confirm the exact slot (date, time, RFD key) before reserving. Never cancel another team's booking. If the RFD already holds a booking (e.g. it was cloned), `reserve_deployment_slot` refuses — ask the user before cancelling and rebooking. The Submit transition stays hidden until required fields + booking + assignee are all complete, so an unbooked RFD is not submittable.

## Field gotchas (from live createmeta)

| Gotcha | Handling |
|---|---|
| Live create screens require more than the process docs say (e.g. RFC also requires Impact, Likelihood, Data Implications?, High Level Technical Deliverables) | Always run `get_field_meta`; build the payload from it |
| "RFD Instructions" / "RFD-subtask Instructions" — required acknowledgment fields | Pass `["Got it."]` |
| Cascading selects (`option-with-child`, e.g. Infrastructure Considerations) | Pass a plain parent value (`"No"`) or `{parent, child}` — the resolver validates against allowed values; pre-shaped `{"value": …}` objects pass through untouched |
| Change type | Normal (default; auto-approves on Submit), Emergency (goes to review), Standard (pre-approved, where enabled) |
| People fields (username-type) | Change Sponsor = business client (never a vendor); Change Coordinator = release manager; Development Team Lead required for TEST/PROD RFDs |
| Target environment options vary per project (DLVR/INT/TEST/PROD/…) | Read the allowed list from `get_field_meta` |

## After creation (the human's workflow)

- RFC: Open → Submit → Approved (Normal auto-approves; Emergency → Under review) → All deployments done → Resolved → Closed. Client approval for PROD is recorded as a comment on the RFC by the coordinator.
- RFD: Open → Submit → Under review → Approved → In progress → Resolved. The routed technical team assigns a person who reviews and Approves; the ticket Reporter is who reliably sees Approve buttons.

## Summary and description style

- Summary: `<APP> <version>: <what> to <ENV>` — e.g. `MYAPP 03.00.02: Deploy API fix to TEST`. No abbreviations like D2T/D2P.
- RFC description: one short plain-language paragraph — what's changing, why, and the impact — readable by a business person. No changelogs, ticket lists, deployment steps, Jira markup, or bare version numbers.
- Deployment detail (build links, script paths, run order) belongs in RFD/RFD-subtask descriptions, not the RFC.

## Common mistakes

- Assuming a CI/pipeline integration auto-creates RFC/RFDs — none exists; you create every ticket.
- Linking RFC↔RFD with `blocks`/`relates to` — the link type is `RFC-RFD`.
- Setting invented date fields ("Planned Start/End") on RFDs — scheduling is the calendar booking.
- Skipping RFD-subtasks when another team must act — each manual step by another team is its own subtask.
- Cloning RFDs without releasing the copied booking — a cloned RFD double-books the slot (`cancel_deployment_booking` on the clone releases it).
