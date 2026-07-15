import { describe, it, expect } from "vitest";
import { parseHeapOutput } from "../../commands/jvm-heap.js";

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
