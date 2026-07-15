import type { ServerEntry } from "@nrs/auth";
import { sshExec } from "../ssh-client.js";

export interface HeapMetrics {
  pid: string;
  xmx: string;
  heapUsedMb: number;
  heapCapMb: number;
  heapPct: number;
  edenUsedMb: number;
  edenCapMb: number;
  oldUsedMb: number;
  oldCapMb: number;
  metaUsedMb: number;
  metaCapMb: number;
  youngGcCount: number;
  youngGcTime: number;
  fullGcCount: number;
  fullGcTime: number;
  totalGcTime: number;
}

export type HeapErrorReason = "not_found" | "no_jstat" | "jstat_failed" | "parse_error";

export type HeapResult =
  | { ok: true; metrics: HeapMetrics }
  | { ok: false; reason: HeapErrorReason; message: string };

const kbToMb = (kb: number): number => Math.floor(kb / 1024);

/**
 * Build the compound remote command that finds the Java PID, locates jstat,
 * and runs jstat -gc. Mirrors ~/bin/server-heap remote_cmd.
 * Outputs: HDATA:pid|xmx|<jstat -gc columns>  or  HERR:<reason>
 */
export function buildHeapCommand(app: string, component: string): string {
  return `
psline=$(ps -ef | grep "[j]ava.*catalina.base=.*/${app}/${component}" | head -1)
if [ -z "$psline" ]; then
  echo "HERR:not_found"
else
  pid=$(echo "$psline" | tr -s " " | cut -d" " -f2)
  xmx=$(echo "$psline" | grep -oE "\\-Xmx[^ ]+" | sed "s/-Xmx//")
  [ -z "$xmx" ] && xmx="?"
  javabin=$(echo "$psline" | grep -oE "/[^ ]*bin/java" | head -1)
  jstat_cmd=""
  if [ -n "$javabin" ]; then
    candidate=$(dirname "$javabin")/jstat
    [ -x "$candidate" ] && jstat_cmd="$candidate"
  fi
  [ -z "$jstat_cmd" ] && [ -x /sw_ux/jdk8/bin/jstat ] && jstat_cmd=/sw_ux/jdk8/bin/jstat
  [ -z "$jstat_cmd" ] && [ -x /sw_ux/activemq/jdk/bin/jstat ] && jstat_cmd=/sw_ux/activemq/jdk/bin/jstat
  [ -z "$jstat_cmd" ] && jstat_cmd=$(which jstat 2>/dev/null || true)
  if [ -n "$jstat_cmd" ]; then
    jdata=$($jstat_cmd -gc $\{pid} 1 1 2>/dev/null | tail -1) || true
    if [ -n "$jdata" ]; then
      printf "HDATA:%s|%s|%s\\n" "$pid" "$xmx" "$jdata"
    else
      echo "HERR:jstat_failed"
    fi
  else
    echo "HERR:no_jstat"
  fi
fi`.trim();
}

/**
 * Parse HDATA output from the heap command into structured metrics.
 * Returns null for HERR lines or unparseable output.
 */
export function parseHeapOutput(raw: string): HeapMetrics | null {
  const hdataLine = raw.split("\n").find(l => l.includes("HDATA:"));
  if (!hdataLine) return null;

  const hdata = hdataLine.replace(/.*HDATA:/, "").trim();
  const [pid, xmx, jstatData] = hdata.split("|");
  // xmx is display-only ("Max Heap"); a JVM with no -Xmx on its command line
  // (relying on default heap ergonomics) yields an empty field — do NOT reject
  // the whole result for that. Only pid + jstat data are required.
  if (!pid || !jstatData) return null;

  const nums = jstatData.trim().split(/\s+/).map(Number);
  if (nums.length < 17 || nums.some(isNaN)) return null;

  const [s0c, s1c, s0u, s1u, ec, eu, oc, ou, mc, mu, , , ygc, ygct, fgc, fgct, gct] = nums;

  const heapUsedKb = (s0u ?? 0) + (s1u ?? 0) + (eu ?? 0) + (ou ?? 0);
  const heapCapKb  = (s0c ?? 0) + (s1c ?? 0) + (ec ?? 0) + (oc ?? 0);
  const heapCapMb  = kbToMb(heapCapKb);

  return {
    pid,
    xmx: xmx || "?",
    heapUsedMb: kbToMb(heapUsedKb),
    heapCapMb,
    heapPct: heapCapMb > 0 ? Math.floor((kbToMb(heapUsedKb) * 100) / heapCapMb) : 0,
    edenUsedMb:  kbToMb(eu ?? 0),
    edenCapMb:   kbToMb(ec ?? 0),
    oldUsedMb:   kbToMb(ou ?? 0),
    oldCapMb:    kbToMb(oc ?? 0),
    metaUsedMb:  kbToMb(mu ?? 0),
    metaCapMb:   kbToMb(mc ?? 0),
    youngGcCount: ygc ?? 0,
    youngGcTime:  ygct ?? 0,
    fullGcCount:  fgc ?? 0,
    fullGcTime:   fgct ?? 0,
    totalGcTime:  gct ?? 0,
  };
}

/** Format heap metrics as a text report (mirrors server-heap terminal output). */
export function formatHeapReport(entry: ServerEntry, app: string, component: string, metrics: HeapMetrics): string {
  const bar = "█".repeat(Math.floor(metrics.heapPct * 30 / 100)) +
              "░".repeat(30 - Math.floor(metrics.heapPct * 30 / 100));
  return [
    `JVM Heap — ${app}/${component} on ${entry.name}`,
    "─".repeat(50),
    "",
    `PID:        ${metrics.pid}`,
    `Max Heap:   ${metrics.xmx}`,
    "",
    `Heap:       [${bar}] ${metrics.heapPct}% (${metrics.heapUsedMb} MB / ${metrics.heapCapMb} MB)`,
    "",
    `Eden:         ${metrics.edenUsedMb} MB / ${metrics.edenCapMb} MB`,
    `Old Gen:      ${metrics.oldUsedMb} MB / ${metrics.oldCapMb} MB`,
    `Metaspace:    ${metrics.metaUsedMb} MB / ${metrics.metaCapMb} MB`,
    "",
    `Young GCs:  ${metrics.youngGcCount} (${metrics.youngGcTime}s)`,
    `Full GCs:   ${metrics.fullGcCount} (${metrics.fullGcTime}s)`,
    `Total GC:   ${metrics.totalGcTime}s`,
  ].join("\n");
}

/** Get JVM heap metrics for an app/component on a server. */
export async function getJvmHeap(
  entry: ServerEntry,
  app: string,
  component: string,
): Promise<HeapResult> {
  const command = buildHeapCommand(app, component);
  const result = await sshExec(entry, command);
  const output = result.stdout + result.stderr;

  if (output.includes("HERR:not_found")) {
    return { ok: false, reason: "not_found", message: `Java process not found for ${app}/${component}` };
  }
  if (output.includes("HERR:no_jstat")) {
    return { ok: false, reason: "no_jstat", message: "jstat not found on server" };
  }
  if (output.includes("HERR:jstat_failed")) {
    return { ok: false, reason: "jstat_failed", message: "jstat ran but returned no data" };
  }

  const metrics = parseHeapOutput(output);
  if (!metrics) {
    return { ok: false, reason: "parse_error", message: "Could not parse jstat output" };
  }
  return { ok: true, metrics };
}
