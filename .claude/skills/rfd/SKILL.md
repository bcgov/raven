---
name: rfd
description: Use when creating or planning release paperwork in NRM Jira — RFCs, RFDs, RFD-subtasks, deployment scheduling/approvals, or any deployment that needs Technical Change and Release Management (TCRM). Also for questions about required RFC/RFD fields or the deployment process.
---

# Creating RFCs and RFDs (NRM Release Paperwork)

## Overview

One **RFC** per release per application (the change record). One **RFD** per target environment (the deployment event). **RFD-subtasks** only when a deployment has multiple steps or people. All tickets live in the application's own Jira project.

## What to create

| Release shape | Create |
|---|---|
| Polaris pipeline, application change only | RFC only (Broker records the deploys) |
| Single-step push-button deploy (a100/ISSS/SMT Jenkins pipelines) | RFC + one RFD per environment with Deployment Category set — no subtasks |
| Multi-step or multi-person (DB scripts, infra changes, stop/start) | RFC + RFDs + one RFD-subtask per step: one per DB script, one per infra service; app stop / deploy / restart are separate subtasks |
| Release spans multiple applications | RFC per application, but ALL RFDs link to the primary app's RFC only |

## Recipe

1. Gather: project key, version, target environments, Change Sponsor and Change Coordinator (resolve usernames with `search_users`), planned PROD date, release contents.
2. Duplicate check: `search_issues` for an open RFC with the same project + fix version. Reuse it rather than creating a second.
3. `get_field_meta` for RFC and RFD (and RFD-subtask if needed) in the target project. Required fields and option values vary per project — never guess them, and trust this over any documentation.
4. Fix Version: `list_versions`; `create_version` if missing.
5. Create the RFC (`create_issue` with `customFields`).
6. Create one RFD per environment, then link each: `link_issues` with linkType `RFC-RFD`, outward = the RFC, inward = the RFD.
7. If subtasks are needed: `create_issue` with issueType `RFD-subtask` and `parentKey` = the RFD. Deployment Category routes the work: Application deployment → App Services, Database change → DBAs (link the script's repo path + README, state run order), Infrastructure configuration change → Infra Services, Other → a named assignee.
8. Report what remains manual (booking, Submit, approvals — see below) and stop.

## Hard gates

- Confirm with the user before every create/link, showing the full field payload first.
- Do NOT transition tickets (Submit/Approve/Resolve), record client approval, or book deployment slots unless the user explicitly asks for that specific action.
- Deployment booking ("Deployment booking → Reserve" calendar on the RFD) is a custom Jira plugin with no API — the user books it in the Jira UI. The Submit transition stays hidden until required fields + booking + assignee are all complete, so an unbookable RFD is not submittable.

## Field gotchas (from live createmeta)

| Gotcha | Handling |
|---|---|
| Live create screens require more than the process docs say (e.g. RFC also requires Impact, Likelihood, Data Implications?, High Level Technical Deliverables) | Always run `get_field_meta`; build the payload from it |
| "RFD Instructions" / "RFD-subtask Instructions" — required acknowledgment fields | Pass `["Got it."]` |
| Cascading selects (`option-with-child`, e.g. Infrastructure Considerations) | Pass a pre-shaped object: `{"Infrastructure Considerations": {"value": "No"}}` — objects bypass the resolver untouched |
| Change type | Normal (default; auto-approves on Submit), Emergency (goes to review), Standard (pre-approved, where enabled) |
| People fields (username-type) | Change Sponsor = business client (never a vendor); Change Coordinator = release manager; Development Team Lead required for TEST/PROD RFDs |
| Target environment options vary per project (DLVR/INT/TEST/PROD/…) | Read the allowed list from `get_field_meta` |

## After creation (the human's workflow)

- RFC: Open → Submit → Approved (Normal auto-approves; Emergency → Under review) → All deployments done → Resolved → Closed. Client approval for PROD is recorded as a comment on the RFC by the coordinator.
- RFD: Open → Submit → Under review → Approved → In progress → Resolved. The routed technical team assigns a person who reviews and Approves; the ticket Reporter is who reliably sees Approve buttons.

## Summary and description style

- Summary: `<APP> <version>: <what> to <ENV>` — e.g. `LEXIS 03.00.02: Deploy API fix to TEST`. No abbreviations like D2T/D2P.
- RFC description: one short plain-language paragraph — what's changing, why, and the impact — readable by a business person. No changelogs, ticket lists, deployment steps, Jira markup, or bare version numbers.
- Deployment detail (Jenkins build links, script paths, run order) belongs in RFD/RFD-subtask descriptions, not the RFC.

## Common mistakes

- Assuming a Jenkins/pipeline integration auto-creates RFC/RFDs — none exists; you create every ticket.
- Linking RFC↔RFD with `blocks`/`relates to` — the link type is `RFC-RFD`.
- Setting invented date fields ("Planned Start/End") on RFDs — scheduling is the calendar booking.
- Skipping RFD-subtasks when another team must act — each manual step by DBAs/Infra is its own subtask.
- Cloning RFDs without releasing the copied booking — a cloned RFD double-books the slot.
