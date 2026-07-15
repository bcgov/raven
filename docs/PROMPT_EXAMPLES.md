# RAVEN — Prompt Examples

Tested prompts for RAVEN MCP tools. Copy-paste ready for VS Code Copilot.
---

## Jira — Morning Standup

```
Look at my open Jira tickets assigned to jsmith across all projects,
check what's in the current sprint, and tell me what I should prioritize
today. Consider priority, blockers, and due dates.
```

Simpler alternative:
```
Search Jira for issues assigned to jsmith that are In Progress or Open.
```

---

## Server Monitor — Search Production Logs

```
Search the production server logs for FTA fta-tenures-api for recent errors.
Show me the most critical ones.
```

Explicit alternative:
```
Search the prod01 server logs for FTA fta-tenures-api for the pattern "ERROR".
```

---

## Bitbucket — Find Root Cause from Logs

Best used as a conversational follow-up after searching logs:
```
search bitbucket to find the source of the errors you found in the log
```

Explicit alternative (standalone):
```
Read the file fta-persistence/src/main/java/ca/bc/gov/nrs/fta/persistence/v1/dao/jpa2/TimberMarkDao.java
from the FTA fta-tenures-api repository on Bitbucket, branch release/2.0.3.
Explain the NoResultException bug around line 117.
```

---

## Jira — Create Bug Ticket from Investigation

Best used as a follow-up after finding a bug in logs + source:
```
create a jira bug in the DEMO project for this issue. provide a description,
proposed solution, acceptance criteria and expected unit tests
```

Explicit alternative (standalone):
```
Create a Jira bug in the FTA project with summary
"fetchBlanketTimberMark throws NoResultException for missing timber marks"
and priority Medium. In the description include: Error in TimberMarkDao
line 117, calls getSingleResult() directly instead of using BaseDao wrapper.
```

---

## Fix Bug + Write Tests + Create PR

These work best as conversational follow-ups after the investigation above:

```
fix the bug
```

```
write unit tests for the fix
```

```
commit the fix and tests, then create a pull request in bitbucket for DEMO-1197
```

---

## Jira — Update Ticket Status

```
update DEMO-1197 status to Under Review and add a comment with the PR link
and a summary of the fix
```

---

## Health — Portfolio Analysis

```
Run a portfolio health analysis across these projects: WEBADE, CMSG, DGEN, CWM.
Show me the health scores, key risks, and security vulnerabilities.
Identify which are candidates for retirement and explain why.
```

Follow-up for detail:
```
show me the detailed risks and security vulnerabilities for each project
```

Simpler alternative:
```
Run project health analysis for WEBADE and CWM.
```

---

## Confluence — Create Page from Analysis

Best used as a follow-up after a health analysis:
```
Create a Confluence page in the DEMO space summarizing the portfolio health
analysis you just ran. Include the scores, risks, and retirement recommendations.
```

---

## Server Monitor — Dashboard

```
Show me the server dashboard with error counts across all environments.
```

---

## Health Score Reference

| Dimension | Max Pts | What it measures |
|-----------|---------|------------------|
| Sprint velocity | 20 | Last sprint completion rate (≥80% = full marks) |
| Issue aging | 20 | % of open issues stale >60 days |
| Stability | 15 | Total open issue count (fewer = healthier) |
| Security posture | 15 | Open FLARE vulnerability tickets (0 = full marks) |
| Documentation freshness | 15 | Avg age of Confluence pages (<90 days = full marks) |
| Code activity | 15 | PRs merged in last 30 days |
| Unassigned work | 10 | % of open issues with no assignee |
| PR review health | 10 | Open PR count and avg age |

**Ratings:** ≥80 Healthy · ≥60 Needs Attention · ≥40 At Risk · <40 Critical
