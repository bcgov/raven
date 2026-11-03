# RFC/RFD Playbook — Release Paperwork in BC Gov Jira

> **Canonical, assistant-agnostic playbook** for creating release paperwork (RFCs, RFDs, RFD-subtasks) with the RAVEN `jira-mcp` tools. The Claude Code skill ([`.claude/skills/rfd/SKILL.md`](../.claude/skills/rfd/SKILL.md)) and the VS Code Copilot prompt ([`.github/prompts/rfd.prompt.md`](../.github/prompts/rfd.prompt.md)) are thin adapters that point here — edit this file, not the adapters. Tool names below are the RAVEN `jira-mcp` tool names and work from any MCP client.

## Overview

One **RFC** per release per application (the change record). One **RFD** per target environment (the deployment event). Each RFD follows one of two workflows, set by its **Deployment Type**:

- **Single-Resource:** one person completes the whole deployment from instructions in the RFD itself, even when it has several ordered steps (for example a DBA's backup followed by a script run). No subtasks.
- **Coordinated:** more than one person or team must act, so each piece of assigned work needs its own review and approval. RFD-subtasks assign, approve and track that work.

The deciding question is who does the work, not how many steps there are.

All tickets live in the application's own Jira project. The simplified screens (the Deployment Type field and a shorter RFC create screen) are being rolled out project by project; `get_field_meta` shows which screens a project has (recipe step 3).

## What to create

| Release shape | Workflow | Create |
|---|---|---|
| The project team deploys an application-only change itself, through a fully automated platform that records its own deploy history | Project team deployment | RFC only — no RFDs |
| One internal staff member can complete the whole deployment, including several ordered steps | Single-Resource | RFC + one RFD per environment with Deployment Type `Single-Resource`. The deployment instructions, in order, go in the RFD description. No subtasks |
| More than one person or team must act, in a set order (for example one team stops and restarts the application while the DBA team runs scripts) | Coordinated | RFC + one RFD per environment with Deployment Type `Coordinated` + one RFD-subtask per piece of assigned work |
| The team deploys its code through an automated platform, but the release also needs DB or configuration changes by internal staff | Coordinated | As above. The team's own platform deploy is a regular `Sub-task` under the RFD, not an RFD-subtask |
| Release spans multiple applications, deployments bundled together | Usually Coordinated | RFC per application, with each secondary RFC linked to the primary app's RFC — but only ONE set of RFDs/RFD-subtasks for the whole release (per environment, subtasks covering every app), all linked to the primary app's RFC. Secondary RFCs get no RFDs |

## Recipe

1. Gather: project key, version, target environments, who will perform each deployment (one person, or several people or teams), Change Sponsor and Change Coordinator (resolve usernames with `search_users`), planned PROD date, release contents.
2. Duplicate check: `search_issues` for an open RFC with the same project + fix version. Reuse it rather than creating a second.
3. `get_field_meta` for RFC and RFD in the target project (plus `RFD-subtask` and `Sub-task` for Coordinated deployments). Required fields and option values vary per project — never guess them, and trust this over any documentation.
   - The RFD screen has **Deployment Type**: the project is on the simplified workflow. Set it on every RFD.
   - No Deployment Type: the project still has the older screens. Leave the field out. Before creating a Single-Resource-style RFD, ask the user whether the project's deployments still need an RFD-subtask for every step (the older pattern). If they do, run `get_field_meta` for `RFD-subtask` and create one RFD-subtask per step: one per DB script, one per infrastructure service, and separate subtasks for application stop, deploy and restart. This overrides step 7: do not combine steps into one subtask or use regular `Sub-task`s, and leave out Deployment Type. Step 7's Deployment Category routing and run-order guidance still apply.
4. Fix Version: `list_versions`; `create_version` if missing.
5. Create the RFC (`create_issue` with `customFields`). If the RFC Category is New Product or Enhancement Release, the RFC must be linked to its PMO ticket before Submit — ask the user for the PMO key and link type, then `link_issues`.
6. Create one RFD per environment, then link each: `link_issues` with linkType `RFC-RFD`, outward = the RFC, inward = the RFD.
7. Finish each RFD for its workflow:
   - **Single-Resource:** put the deployment steps and artifact links in the RFD description, so the assignee needs nothing else. Assignee: the user, if they are internal staff doing the deployment themselves; otherwise the routed team's shared mailbox account (application deployment, database changes, or infrastructure configuration — find it with `search_assignable_users`). The team then reassigns it to a person.
   - **Coordinated:** create one RFD-subtask per piece of assigned work (`create_issue` with issueType `RFD-subtask` and `parentKey` = the RFD). One person's consecutive steps can share a subtask (for example a DBA's backup and script run); work by different people, or at different points in the deployment, gets its own subtask. Deployment Category routes each RFD-subtask: Application deployment → the application delivery team, Database change → the DBA team (link the script's repo path + README, state run order), Infrastructure configuration change → the infrastructure team, Other → the person creating it. Project-team activities that need no technical approval (such as the team's own pipeline deploy) are regular `Sub-task`s under the RFD. Jira does not enforce order, so state the run order in the RFD description. Plan each environment separately: PROD may need stop and restart steps that a non-live environment does not.
8. Scheduling: when internal staff will perform a TEST or PROD deployment (Automated Pipeline? = No), offer open slots at least three working days out (`list_deployment_slots`; `get_deployment_booking` shows an RFD's existing booking). For a Coordinated deployment, the booking is on the parent RFD. If the user asks you to book, confirm the exact slot, then `reserve_deployment_slot`. Report what remains manual (Submit, approvals — see below) and stop.

## Hard gates

- Confirm with the user before every create/link, showing the full field payload (including any assignee) first.
- Do NOT transition tickets (Submit/Approve/Resolve), record client approval, or book deployment slots unless the user explicitly asks for that specific action.
- Deployment booking: view freely (`list_deployment_slots`, `get_deployment_booking`); reserve or cancel (`reserve_deployment_slot`, `cancel_deployment_booking`) only when the user explicitly asks, and confirm the exact slot (date, time, RFD key) before reserving. Never cancel another team's booking. If the RFD already holds a booking (e.g. it was cloned), `reserve_deployment_slot` refuses — ask the user before cancelling and rebooking. The Submit transition stays hidden until required fields, booking and assignee are all complete, so an unbooked RFD that needs a slot is not submittable.

## Field gotchas (from live createmeta)

| Gotcha | Handling |
|---|---|
| Required fields differ by screen. Older RFC create screens require much more than the process docs say (Impact, Likelihood, Data Implications?, High Level Technical Deliverables, Infrastructure Considerations, Automated Pipeline?); the simplified RFC screen requires only Summary, RFC Category, Change type, Change Sponsor and Change Coordinator | Always run `get_field_meta`; build the payload from it |
| Deployment Type values are `Single-Resource` and `Coordinated` (the process docs write "Single Resource") | Use the exact value from `get_field_meta` |
| Deployment Category exists only on RFD-subtasks, not on RFDs | Route a Single-Resource RFD with its Assignee |
| Automated Pipeline? (on the RFD) | No (default): internal staff are needed, so TEST/PROD need a booked slot. Yes: a self-service deployment with no staff scheduling |
| Who will verify this deployment? | Required before Submit. For PROD it must be the client; for DLVR/TEST it can be a vendor or team member |
| "RFD Instructions" / "RFD-subtask Instructions" — required acknowledgment fields | Pass `["Got it."]` |
| Cascading selects (`option-with-child`, e.g. Infrastructure Considerations) | Pass a plain parent value (`"No"`) or `{parent, child}` — the resolver validates against allowed values; pre-shaped `{"value": …}` objects pass through untouched |
| Change type | Normal (default; auto-approves on Submit), Emergency (goes to review), Standard (pre-approved, where enabled) |
| People fields (username-type) | Change Sponsor = business client (never a vendor); Change Coordinator = release manager; Development Team Lead = the developer available during the deployment (required before Submit) |
| Target environment options vary per project (DLVR/INT/TEST/PROD/…) | Read the allowed list from `get_field_meta` |

## After creation (the human's workflow)

- RFC: Open → Submit → Approved (Normal approves automatically; Emergency goes to Under Review first) → All deployments done → Resolved → Closed. A resolved RFC closes automatically unless PIR Required is set; Jira sets it when a deployment fails. Client approval for PROD is recorded as a comment on the RFC, by the client or the coordinator. There is no Jira button for it, and the internal Approved statuses do not replace it.
- RFD: Open → Submit → Under Review → Approved → In Progress → Resolved → Closed. Some lower-environment RFDs go straight to Approved on Submit.
  - Single-Resource: the assignee reviews the instructions (allow three days), selects Approve, then Start Progress and Resolve.
  - Coordinated: each assignee approves their own RFD-subtask; once all are approved, the release manager approves the parent RFD. The parent's status then follows its subtasks automatically.

## Summary and description style

- RFC summary: `<APP> <release or timeframe>: <purpose>` — e.g. `MYAPP Online Payments (Jan 2026): Apply Security Patch`.
- RFD summary: `Deploy <APP> <version> to <ENV>` — e.g. `Deploy MYAPP 6.3 to TEST`. No abbreviations like D2T/D2P.
- RFD-subtask summary: the activity — e.g. `Back up database and apply database changes`.
- RFC description: one short plain-language paragraph — what's changing, why, and the impact — readable by a business person. No changelogs, ticket lists, deployment steps, Jira markup, or bare version numbers.
- Deployment detail (build links, script paths, run order) belongs in the Single-Resource RFD's description or in RFD-subtask descriptions, never the RFC. A Coordinated RFD's description carries the overall run order across its subtasks.

## Common mistakes

- Assuming a CI/pipeline integration auto-creates RFC/RFDs — none exists; you create every ticket.
- Linking RFC↔RFD with `blocks`/`relates to` — the link type is `RFC-RFD`.
- Setting invented date fields ("Planned Start/End") on RFDs — scheduling is the calendar booking.
- Choosing Single-Resource when another person or team must act — use Coordinated, with one RFD-subtask per piece of assigned work.
- Choosing Coordinated only because one person's deployment has several steps — that is still Single-Resource.
- Setting Deployment Category on an RFD — it exists only on RFD-subtasks.
- Using an RFD-subtask for project-team work that needs no technical approval — use a regular `Sub-task`.
- Cloning RFDs without releasing the copied booking — a cloned RFD double-books the slot (`cancel_deployment_booking` on the clone releases it).
