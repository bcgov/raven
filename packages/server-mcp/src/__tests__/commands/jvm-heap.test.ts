import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHeapCommand, parseHeapOutput } from "../../commands/jvm-heap.js";

describe.skipIf(process.platform === "win32")("heap process selection", () => {
  it.each(["", "/"])("matches dotted identifiers and the complete component path (suffix %j)", suffix => {
    const dir = mkdtempSync(join(tmpdir(), "raven-heap-match-"));
    const bin = join(dir, "bin");
    try {
      mkdirSync(bin);
      writeFileSync(join(bin, "ps"), '#!/bin/sh\ncat "$FIXTURE_PS"\n', { mode: 0o700 });
      writeFileSync(join(bin, "jstat"), '#!/bin/sh\necho "fixture metrics"\n', { mode: 0o700 });
      const paths = ["APPx1/api.v2", "APP.1/apixv2", "APP.1/api.v2-extra", `APP.1/api.v2${suffix}`];
      writeFileSync(join(dir, "processes"), paths.map((path, index) =>
        `tester ${index + 11} 1 0 00:00 ? 00:00:00 ${bin}/java -Xmx256m -Dcatalina.base=/apps/${path} other-arg\n`,
      ).join(""));
      const output = execFileSync("/bin/sh", ["-c", buildHeapCommand("APP.1", "api.v2")], {
        env: { PATH: `${bin}:/usr/bin:/bin`, FIXTURE_PS: join(dir, "processes") }, timeout: 2_000, encoding: "utf-8",
      });
      expect(output).toBe("HDATA:14|256m|fixture metrics\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseHeapOutput", () => {
  it("parses HDATA line into heap metrics", () => {
    // jstat -gc columns: S0C S1C S0U S1U EC EU OC OU MC MU CCSC CCSU YGC YGCT FGC FGCT GCT
    const raw = "HDATA:12345|512m|51200.0 51200.0 1024.0 0.0 409600.0 204800.0 1048576.0 524288.0 65536.0 62000.0 8192.0 7000.0 42 1.234 3 0.567 1.801";
    const heap = parseHeapOutput(raw);
    expect(heap).not.toBeNull();
    expect(heap!.pid).toBe("12345");
    expect(heap!.xmx).toBe("512m");
    expect(heap!.heapUsedMb).toBeGreaterThan(0);
    expect(heap!.heapCapMb).toBeGreaterThan(0);
    expect(heap!.youngGcCount).toBe(42);
    expect(heap!.fullGcCount).toBe(3);
  });

  it("parses HDATA when xmx is empty (JVM has no -Xmx on its command line)", () => {
    // Regression: FTA/RESULTS Tomcats on prod03 run without an explicit -Xmx,
    // so the shell emits an empty xmx field (HDATA:pid||<jstat>). The valid
    // heap data must still parse; xmx falls back to "?". Real ftc-war sample.
    const raw = "HDATA:10919||14336.0 19456.0 0.0 0.0 391168.0 244138.2 243712.0 23211.7 35416.0 34533.3 4352.0 4105.9 4 0.083 2 0.077 0.159";
    const heap = parseHeapOutput(raw);
    expect(heap).not.toBeNull();
    expect(heap!.pid).toBe("10919");
    expect(heap!.xmx).toBe("?");
    expect(heap!.heapCapMb).toBeGreaterThan(0);
    expect(heap!.fullGcCount).toBe(2);
  });

  it("returns null for HERR:not_found", () => {
    expect(parseHeapOutput("HERR:not_found")).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(parseHeapOutput("")).toBeNull();
  });

  it("returns null for HERR:no_jstat", () => {
    expect(parseHeapOutput("HERR:no_jstat")).toBeNull();
  });
});
