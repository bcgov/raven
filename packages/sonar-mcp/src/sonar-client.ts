import type {
  SonarIssuesPage,
  SonarQualityGateStatus,
  SonarHotspotsPage,
  SonarComponentMeasures,
  SonarAnalysesPage,
} from "./types.js";

/**
 * REST client for SonarQube Server (Community Build + Community Branch Plugin
 * or commercial editions). Targets the stable Web API surface; branch-aware
 * endpoints work transparently when the Community Branch Plugin is installed.
 *
 * Auth: User token via HTTP Basic auth with an empty password
 *   Authorization: Basic base64("<token>:")
 */
export class SonarClient {
  private baseUrl: string;
  private authHeader: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(baseUrl: string, token: string, fetchFn?: typeof globalThis.fetch) {
    let url = baseUrl;
    while (url.endsWith("/")) url = url.slice(0, -1);
    this.baseUrl = url;
    this.authHeader = `Basic ${Buffer.from(`${token}:`).toString("base64")}`;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------
  private async request<T>(
    path: string,
    options?: RequestInit & { params?: Record<string, string | number | boolean | undefined> },
  ): Promise<T> {
    const { params, ...fetchOpts } = options ?? {};
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === "") continue;
        qs.append(k, String(v));
      }
    }
    const query = qs.toString() ? `?${qs}` : "";
    const url = `${this.baseUrl}/${path.replace(/^\//, "")}${query}`;

    const resp = await this.fetchFn(url, {
      ...fetchOpts,
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        ...(fetchOpts.headers ?? {}),
      },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `SonarQube API error ${resp.status} ${resp.statusText} on ${path}: ${body.slice(0, 500)}`,
      );
    }
    if (resp.status === 204) return {} as T;
    return (await resp.json()) as T;
  }

  // ---------------------------------------------------------------------------
  // Issues
  // ---------------------------------------------------------------------------
  /**
   * Search issues for a project on a given branch.
   * @param inNewCodePeriod  When true, restricts to issues in the New Code period.
   */
  async searchIssues(
    projectKey: string,
    branch: string,
    opts: {
      inNewCodePeriod?: boolean;
      severities?: string[];      // BLOCKER,CRITICAL,...
      types?: string[];           // BUG,VULNERABILITY,CODE_SMELL
      statuses?: string[];        // OPEN,CONFIRMED,REOPENED (default: open-ish)
      pageSize?: number;          // max 500
      page?: number;
    } = {},
  ): Promise<SonarIssuesPage> {
    const statuses = opts.statuses?.join(",") ?? "OPEN,CONFIRMED,REOPENED";
    return this.request<SonarIssuesPage>("api/issues/search", {
      params: {
        componentKeys: projectKey,
        branch,
        statuses,
        severities: opts.severities?.join(","),
        types: opts.types?.join(","),
        sinceLeakPeriod: opts.inNewCodePeriod ? "true" : undefined,
        ps: opts.pageSize ?? 500,
        p: opts.page ?? 1,
        s: "SEVERITY",
        asc: "false",
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Quality gate
  // ---------------------------------------------------------------------------
  async getQualityGate(projectKey: string, branch?: string): Promise<SonarQualityGateStatus> {
    return this.request<SonarQualityGateStatus>("api/qualitygates/project_status", {
      params: { projectKey, branch },
    });
  }

  // ---------------------------------------------------------------------------
  // Analyses (scan history)
  // ---------------------------------------------------------------------------
  async listAnalyses(projectKey: string, branch?: string, pageSize = 1): Promise<SonarAnalysesPage> {
    return this.request<SonarAnalysesPage>("api/project_analyses/search", {
      params: { project: projectKey, branch, ps: pageSize },
    });
  }

  // ---------------------------------------------------------------------------
  // Hotspots
  // ---------------------------------------------------------------------------
  async searchHotspots(
    projectKey: string,
    branch: string,
    opts: { includeAcknowledged?: boolean; pageSize?: number; page?: number } = {},
  ): Promise<SonarHotspotsPage> {
    // status=TO_REVIEW returns unreviewed; status=REVIEWED returns reviewed
    // (which includes SAFE / FIXED / ACKNOWLEDGED resolutions).
    // We make two calls and merge so the caller gets one consistent list.
    const toReview = await this.request<SonarHotspotsPage>("api/hotspots/search", {
      params: {
        projectKey,
        branch,
        status: "TO_REVIEW",
        ps: opts.pageSize ?? 500,
        p: opts.page ?? 1,
      },
    });
    if (!opts.includeAcknowledged) return toReview;

    const reviewed = await this.request<SonarHotspotsPage>("api/hotspots/search", {
      params: {
        projectKey,
        branch,
        status: "REVIEWED",
        resolution: "ACKNOWLEDGED",
        ps: opts.pageSize ?? 500,
        p: opts.page ?? 1,
      },
    });
    return {
      paging: {
        pageIndex: toReview.paging.pageIndex,
        pageSize: toReview.paging.pageSize,
        total: toReview.paging.total + reviewed.paging.total,
      },
      hotspots: [...toReview.hotspots, ...reviewed.hotspots],
    };
  }

  // ---------------------------------------------------------------------------
  // Measures (project metrics on main branch)
  // ---------------------------------------------------------------------------
  async getComponentMeasures(
    projectKey: string,
    metricKeys: string[],
    branch?: string,
  ): Promise<SonarComponentMeasures> {
    return this.request<SonarComponentMeasures>("api/measures/component", {
      params: {
        component: projectKey,
        metricKeys: metricKeys.join(","),
        branch,
        additionalFields: "metrics,period",
      },
    });
  }

  /** Used to discover the project's main branch name when not supplied. */
  async listBranches(projectKey: string): Promise<{ branches: Array<{ name: string; isMain: boolean; type: string }> }> {
    return this.request("api/project_branches/list", { params: { project: projectKey } });
  }

  /** Lightweight component lookup (name, qualifier, visibility, tags, language). */
  async getComponent(projectKey: string, branch?: string): Promise<{ component: SonarComponentMeasures["component"] }> {
    return this.request("api/components/show", { params: { component: projectKey, branch } });
  }
}