import type { ServerEntry } from "@nrs/auth";
import { sshExec } from "../ssh-client.js";

export interface DiskUsage {
  filesystem: string;
  size: string;
  used: string;
  available: string;
  usePercent: string;
  mountpoint: string;
}

export interface LoadData {
  uptime: string;
  load1: number;
  load5: number;
  load15: number;
  memTotalMb: number;
  memUsedMb: number;
  memPercent: number;
  disks: DiskUsage[];
}

/**
 * Build the remote command that emits tagged lines:
 *   UPTIME: <human-readable>
 *   LOAD:   <l1> <l5> <l15>
 *   MEM:    <total_mb> <used_mb> (<pct>%)
 *   DISK:   <fs> | <size> | <used> | <avail> | <pct> | <mount>
 *
 * Mirrors ~/bin/server-load remote_cmd. Designed to be portable across
 * Linux (Tomcat) and Solaris (legacy) hosts — uses /proc/* when available,
 * falls back to uptime/vmstat/prtconf otherwise.
 */
export function buildLoadCommand(): string {
  return `
uptimeraw=$(cat /proc/uptime 2>/dev/null | cut -d" " -f1)
if [ -n "$uptimeraw" ]; then
  days=$(echo "$uptimeraw" | awk "{printf \\"%d\\", \\$1 / 86400}")
  hours=$(echo "$uptimeraw" | awk "{printf \\"%d\\", (\\$1 % 86400) / 3600}")
  mins=$(echo "$uptimeraw" | awk "{printf \\"%d\\", (\\$1 % 3600) / 60}")
  printf "UPTIME: %s days, %s:%02d\\n" "$days" "$hours" "$mins"
else
  ut=$(uptime 2>/dev/null)
  if [ -n "$ut" ]; then
    up_part=$(echo "$ut" | sed -n "s/.*up *\\(.*\\),.*user.*/\\1/p" | sed "s/,*$//" | xargs)
    [ -n "$up_part" ] && printf "UPTIME: %s\\n" "$up_part"
  fi
fi
loadavg=$(cat /proc/loadavg 2>/dev/null)
if [ -n "$loadavg" ]; then
  l1=$(echo "$loadavg" | cut -d" " -f1)
  l5=$(echo "$loadavg" | cut -d" " -f2)
  l15=$(echo "$loadavg" | cut -d" " -f3)
  printf "LOAD: %s %s %s\\n" "$l1" "$l5" "$l15"
else
  ut=$(uptime 2>/dev/null)
  if [ -n "$ut" ]; then
    loads=$(echo "$ut" | sed -n "s/.*load average[s]*: *\\(.*\\)/\\1/p" | tr -d " ")
    if [ -n "$loads" ]; then
      l1=$(echo "$loads" | cut -d, -f1)
      l5=$(echo "$loads" | cut -d, -f2)
      l15=$(echo "$loads" | cut -d, -f3)
      printf "LOAD: %s %s %s\\n" "$l1" "$l5" "$l15"
    fi
  fi
fi
meminfo=$(cat /proc/meminfo 2>/dev/null)
if [ -n "$meminfo" ]; then
  total=$(echo "$meminfo" | grep "^MemTotal:" | awk "{print \\$2}")
  avail=$(echo "$meminfo" | grep "^MemAvailable:" | awk "{print \\$2}")
  if [ -n "$total" ] && [ -n "$avail" ]; then
    used=$((total - avail))
    total_mb=$((total / 1024))
    used_mb=$((used / 1024))
    pct=$((used * 100 / total))
    printf "MEM: %s %s (%s%%)\\n" "$total_mb" "$used_mb" "$pct"
  fi
fi
df -h 2>/dev/null | grep -E "^/" | while read fs size used avail pct mount; do
  printf "DISK: %s | %s | %s | %s | %s | %s\\n" "$fs" "$size" "$used" "$avail" "$pct" "$mount"
done`.trim();
}

/**
 * Parse tagged lines into LoadData. Returns null if UPTIME is absent.
 *
 * Walks lines once and splits each by its known delimiter rather than
 * matching with regex. The previous regex form (`/^DISK:\s*(.+?)\s*\|.../`
 * etc.) was flagged by CodeQL as polynomial backtracking on uncontrolled
 * input (CodeQL js/polynomial-redos). The shell side of buildLoadCommand
 * controls the format, so the input is well-defined — splits are both
 * faster and ReDoS-immune.
 */
export function parseLoadOutput(raw: string): LoadData | null {
  let uptime: string | null = null;
  let load1 = 0, load5 = 0, load15 = 0;
  let memTotalMb = 0, memUsedMb = 0, memPercent = 0;
  const disks: DiskUsage[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith("UPTIME:")) {
      uptime = line.slice("UPTIME:".length).trim();
    } else if (line.startsWith("LOAD:")) {
      const parts = line.slice("LOAD:".length).trim().split(/\s+/);
      load1 = parseFloat(parts[0] ?? "0") || 0;
      load5 = parseFloat(parts[1] ?? "0") || 0;
      load15 = parseFloat(parts[2] ?? "0") || 0;
    } else if (line.startsWith("MEM:")) {
      // Format: "<total_mb> <used_mb> (<pct>%)"
      const parts = line.slice("MEM:".length).trim().split(/\s+/);
      memTotalMb = parseInt(parts[0] ?? "0", 10) || 0;
      memUsedMb = parseInt(parts[1] ?? "0", 10) || 0;
      const pctRaw = (parts[2] ?? "").replace(/[()%]/g, "");
      memPercent = parseFloat(pctRaw) || 0;
    } else if (line.startsWith("DISK:")) {
      // Format: "<fs> | <size> | <used> | <avail> | <pct> | <mount>"
      const fields = line.slice("DISK:".length).split("|").map((f) => f.trim());
      if (fields.length === 6 && fields.every((f) => f.length > 0)) {
        disks.push({
          filesystem: fields[0]!,
          size: fields[1]!,
          used: fields[2]!,
          available: fields[3]!,
          usePercent: fields[4]!,
          mountpoint: fields[5]!,
        });
      }
    }
  }

  if (uptime === null) return null;

  return { uptime, load1, load5, load15, memTotalMb, memUsedMb, memPercent, disks };
}

/** Fetch system load metrics for one server. */
export async function getServerLoad(
  entry: ServerEntry,
  timeoutMs: number = 30_000,
): Promise<LoadData | null> {
  const command = buildLoadCommand();
  const result = await sshExec(entry, command, timeoutMs);
  return parseLoadOutput(result.stdout);
}
