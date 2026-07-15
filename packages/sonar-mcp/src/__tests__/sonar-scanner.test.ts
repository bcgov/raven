import { describe, it, expect, vi, beforeEach } from "vitest";
import { runScan, isValidSonarScanner, parseSonarConfig, getMergedSonarProps, hasDotNetCode } from "../sonar-scanner.js";
import spawn from "cross-spawn";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { EventEmitter } from "events";

vi.mock("cross-spawn", () => {
  const mockSpawn = vi.fn();
  (mockSpawn as any).sync = vi.fn();
  return {
    default: mockSpawn,
  };
});

vi.mock("node:fs", () => {
  return {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
  };
});

class MockChildProcess extends EventEmitter {
  public stdout = new EventEmitter();
  public stderr = new EventEmitter();
  public kill = vi.fn();
}

describe("runScan process execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it("triggers spawn with the correct binary and arguments", async () => {
    const mockChild = new MockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChild as any);

    const scanPromise = runScan({
      projectKey: "my-proj",
      branch: "feature/test",
      projectDir: "/my/workspace",
      serverUrl: "https://sonar.example.com",
      token: "token123",
      exclusions: "**/mock/**",
      cpdExclusions: "**/skip-cpd/**",
      coverageExclusions: "**/skip-coverage/**",
      extraArgs: ["-Dsonar.log.level=DEBUG"],
    });

    expect(spawn).toHaveBeenCalledWith(
      "sonar-scanner",
      [
        "-Dsonar.projectKey=my-proj",
        "-Dsonar.branch.name=feature/test",
        "-Dsonar.host.url=https://sonar.example.com",
        "-Dsonar.token=token123",
        "-Dsonar.exclusions=**/mock/**",
        "-Dsonar.cpd.exclusions=**/skip-cpd/**",
        "-Dsonar.coverage.exclusions=**/skip-coverage/**",
        "-Dsonar.log.level=DEBUG",
      ],
      expect.objectContaining({ cwd: "/my/workspace" })
    );

    mockChild.stdout.emit("data", Buffer.from("INFO: Scanner running\n"));
    mockChild.stderr.emit("data", Buffer.from("WARN: Deprecated property\n"));
    mockChild.emit("close", 0);

    const result = await scanPromise;
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTail).toContain("INFO: Scanner running");
    expect(result.stderrTail).toContain("WARN: Deprecated property");
  });

  it("handles non-zero exit code failure", async () => {
    const mockChild = new MockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChild as any);

    const scanPromise = runScan({
      projectKey: "my-proj",
      branch: "main",
      projectDir: "/my/dir",
      serverUrl: "https://sonar.example.com",
      token: "tok",
    });

    mockChild.stdout.emit("data", Buffer.from("Scan started...\n"));
    mockChild.stderr.emit("data", Buffer.from("ERROR: Analysis failed\n"));
    mockChild.emit("close", 1);

    const result = await scanPromise;
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stdoutTail).toContain("Scan started...");
    expect(result.stderrTail).toContain("ERROR: Analysis failed");
  });

  it("handles spawn error event", async () => {
    const mockChild = new MockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChild as any);

    const scanPromise = runScan({
      projectKey: "my-proj",
      branch: "main",
      projectDir: "/my/dir",
      serverUrl: "https://sonar.example.com",
      token: "tok",
    });

    mockChild.emit("error", new Error("Spawn error occurred"));

    const result = await scanPromise;
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.stderrTail).toContain("Spawn error occurred");
  });

  it("terminates when reaching timeout", async () => {
    const mockChild = new MockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChild as any);

    const scanPromise = runScan({
      projectKey: "my-proj",
      branch: "main",
      projectDir: "/my/dir",
      serverUrl: "https://sonar.example.com",
      token: "tok",
      timeoutMs: 50,
    });

    // Wait for timeout setting to fire SIGTERM kill
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
    mockChild.emit("close", null);

    const result = await scanPromise;
    expect(result.success).toBe(false);
  });
});

describe("SonarQube Configuration Parsing and Validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parseSonarConfig parses correct properties and ignores comments/whitespace", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(`
      # This is a comment
      ; This is also a comment
      exclusions = **/node_modules/**,**/dist/**

      cpdExclusions=**/tests/**
      emptyKey=
    `);

    const parsed = parseSonarConfig("/fake/sonar.config");
    expect(parsed.exclusions).toBe("**/node_modules/**,**/dist/**");
    expect(parsed.cpdExclusions).toBe("**/tests/**");
    expect(parsed.emptyKey).toBe("");
  });

  it("getMergedSonarProps merges global and local layouts with order of precedence", () => {
    // Mock files existence
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (String(p).includes("global") || String(p).includes("sonar.config")) return true;
      return false;
    });

    vi.mocked(readFileSync).mockImplementation((p: any) => {
      if (String(p).includes("global") || !String(p).includes("project-dir")) {
        return `
          exclusions=global-exclusion
          cpdExclusions=global-cpd
        `;
      }
      if (String(p).includes("project-dir")) {
        return `
          exclusions=project-exclusion
          coverageExclusions=project-coverage
        `;
      }
      return "";
    });

    const props = getMergedSonarProps("project-dir");
    expect(props.exclusions).toBe("project-exclusion"); // Overridden
    expect(props.cpdExclusions).toBe("global-cpd"); // Kept of global
    expect(props.coverageExclusions).toBe("project-coverage"); // Set of project
  });

  it("isValidSonarScanner correctly returns true on valid binary output", () => {
    vi.mocked(spawn.sync).mockReturnValue({
      status: 0,
      stdout: Buffer.from("SonarScanner 5.0.1.3006\n"),
      stderr: Buffer.from(""),
    } as any);
    const result = isValidSonarScanner("/some/bin", true);
    expect(result).toBe(true);
    expect(spawn.sync).toHaveBeenCalledWith("/some/bin", ["-v"], expect.any(Object));
  });

  it("isValidSonarScanner returns false on invalid binary output", () => {
    vi.mocked(spawn.sync).mockReturnValue({
      status: 0,
      stdout: Buffer.from("invalid command output\n"),
      stderr: Buffer.from(""),
    } as any);
    const result = isValidSonarScanner("/some/bad/bin", true);
    expect(result).toBe(false);
  });

  it("isValidSonarScanner returns false on execution error", () => {
    vi.mocked(spawn.sync).mockReturnValue({
      status: 127,
      error: new Error("fail"),
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    } as any);
    const result = isValidSonarScanner("/nonexistent/bin", true);
    expect(result).toBe(false);
  });
});

describe("MSBuild/DotNet detection and execution tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("hasDotNetCode", () => {
    it("returns true if C# file is present", () => {
      vi.mocked(readdirSync).mockReturnValue(["my-app.cs"] as any);
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as any);

      const res = hasDotNetCode("/some/dir");
      expect(res).toBe(true);
    });

    it("returns true if csproj file is present", () => {
      vi.mocked(readdirSync).mockReturnValue(["MyApp.csproj"] as any);
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as any);

      const res = hasDotNetCode("/some/dir");
      expect(res).toBe(true);
    });

    it("returns false if no MSBuild files are found", () => {
      vi.mocked(readdirSync).mockReturnValue(["index.js", "package.json"] as any);
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as any);

      const res = hasDotNetCode("/some/dir");
      expect(res).toBe(false);
    });

    it("ignores node_modules directories recursively", () => {
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        if (p === "/some/dir") {
          return ["node_modules", "src"] as any;
        }
        if (p.includes("node_modules")) {
          return ["ignored.cs"] as any;
        }
        if (p.includes("src")) {
          return ["index.js"] as any;
        }
        return [] as any;
      });

      vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);

      const res = hasDotNetCode("/some/dir");
      expect(res).toBe(false);
    });
  });

  describe("runScan with MSBuild scanner support", () => {
    it("successfully runs MSBuild scanner 3-step sequence when useMsBuild is true", async () => {
      const spawnedChildren: MockChildProcess[] = [];
      vi.mocked(spawn).mockImplementation(() => {
        const child = new MockChildProcess();
        spawnedChildren.push(child);
        return child as any;
      });

      // We bypass actual existsSync checks since we are in test environment, but we must make sure the file URL/paths resolved correctly
      vi.mocked(existsSync).mockImplementation((path: any) => {
        // Mock existence of sonar.config if requested or MSBuild scanner binary
        if (path.includes("SonarScanner.MSBuild.exe") || path.includes("SonarScanner.MSBuild.dll")) {
          return true;
        }
        return false;
      });

      const scanPromise = runScan({
        projectKey: "dotnet-project",
        branch: "main",
        projectDir: "/my/dotnet-app",
        serverUrl: "https://sonar.example.com",
        token: "sonar-tok-456",
        exclusions: "**/obj/**",
        useMsBuild: true,
      });

      // Step 1: begin should be spawned
      // Let's emit stdout for Step 1
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spawnedChildren.length).toBe(1);
      spawnedChildren[0].stdout.emit("data", Buffer.from("Begin Analysis Success"));
      spawnedChildren[0].emit("close", 0);

      // Step 2: build should be spawned
      // We set setTimeout 10 to yield macro-tasks so the next spawn triggers
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spawnedChildren.length).toBe(2);
      spawnedChildren[1].stdout.emit("data", Buffer.from("Build Success"));
      spawnedChildren[1].emit("close", 0);

      // Step 3: end should be spawned
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spawnedChildren.length).toBe(3);
      spawnedChildren[2].stdout.emit("data", Buffer.from("End Analysis Success"));
      spawnedChildren[2].emit("close", 0);

      const result = await scanPromise;
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdoutTail).toContain("Begin Analysis Success");
      expect(result.stdoutTail).toContain("Build Success");
      expect(result.stdoutTail).toContain("End Analysis Success");

      // Verify that spawn was called at least 3 times
      expect(spawn).toHaveBeenCalledTimes(3);

      // Verify arguments of Step 1
      expect(spawn).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining("SonarScanner.MSBuild.exe"),
        expect.arrayContaining([
          "begin",
          "/k:dotnet-project",
          "/d:sonar.host.url=https://sonar.example.com",
          "/d:sonar.token=sonar-tok-456",
          "/d:sonar.branch.name=main",
          "/d:sonar.exclusions=**/obj/**",
        ]),
        expect.any(Object)
      );

      // Verify arguments of Step 2
      expect(spawn).toHaveBeenNthCalledWith(
        2,
        "dotnet",
        ["build"],
        expect.any(Object)
      );

      // Verify arguments of Step 3
      expect(spawn).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining("SonarScanner.MSBuild.exe"),
        [
          "end",
          "/d:sonar.token=sonar-tok-456",
        ],
        expect.any(Object)
      );
    });

    it("terminates 3-step sequence early if step 1 fails", async () => {
      const spawnedChildren: MockChildProcess[] = [];
      vi.mocked(spawn).mockImplementation(() => {
        const child = new MockChildProcess();
        spawnedChildren.push(child);
        return child as any;
      });

      // We bypass existsSync by returning true
      vi.mocked(existsSync).mockReturnValue(true);

      const scanPromise = runScan({
        projectKey: "dotnet-project",
        branch: "main",
        projectDir: "/my/dotnet-app",
        serverUrl: "https://sonar.example.com",
        token: "sonar-tok-456",
        useMsBuild: true,
      });

      // Yield to let step 1 spawn
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spawnedChildren.length).toBe(1);

      // Emit failure for step 1
      spawnedChildren[0].stderr.emit("data", Buffer.from("Begin Analysis Failed"));
      spawnedChildren[0].emit("close", 1);

      const result = await scanPromise;
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stdoutTail).toContain("[STEP 1: BEGIN]");
      expect(result.stderrTail).toContain("Begin Analysis Failed");

      // Verify that it only spawned step 1 and was not called again
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe("runScan with Node.js/Fallback support", () => {
    it("successfully runs node/npm tests if runTests is true and reports coverage", async () => {
      const spawnedChildren: MockChildProcess[] = [];
      vi.mocked(spawn).mockImplementation(() => {
        const child = new MockChildProcess();
        spawnedChildren.push(child);
        return child as any;
      });

      vi.mocked(existsSync).mockImplementation((path: any) => {
        if (path.includes("package.json")) return true;
        return false;
      });

      // Mock node package.json with test script
      vi.mocked(readFileSync).mockImplementation((path: any) => {
        if (path.includes("package.json")) {
          return JSON.stringify({
            scripts: {
              test: "vitest run",
            },
          });
        }
        return "";
      });

      const scanPromise = runScan({
        projectKey: "node-project",
        branch: "main",
        projectDir: "/my/node-app",
        serverUrl: "https://sonar.example.com",
        token: "sonar-tok-012",
        runTests: true,
      });

      // Yield tasks to let the npm test process spawn
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spawnedChildren.length).toBe(1);

      // The npm test step executes first
      spawnedChildren[0].stdout.emit("data", Buffer.from("Node Test Output Details"));
      spawnedChildren[0].emit("close", 0);

      // Now regular sonar-scanner executes next
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spawnedChildren.length).toBe(2);

      spawnedChildren[1].stdout.emit("data", Buffer.from("Sonar Standard Scan Success Output"));
      spawnedChildren[1].emit("close", 0);

      const result = await scanPromise;
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdoutTail).toContain("Node Test Output Details");
      expect(result.stdoutTail).toContain("Sonar Standard Scan Success Output");

      // Verify that npm test was spawned
      expect(spawn).toHaveBeenCalledWith(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["test"],
        expect.any(Object)
      );

      // Verify that sonar-scanner has the coverage lcov argument
      expect(spawn).toHaveBeenCalledWith(
        "sonar-scanner",
        expect.arrayContaining([
          "-Dsonar.javascript.lcov.reportPaths=coverage/lcov.info,**/coverage/lcov.info",
        ]),
        expect.any(Object)
      );
    });

    it("terminates normal scan sequence early if npm tests fail", async () => {
      const spawnedChildren: MockChildProcess[] = [];
      vi.mocked(spawn).mockImplementation(() => {
        const child = new MockChildProcess();
        spawnedChildren.push(child);
        return child as any;
      });

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          scripts: { test: "exit 1" },
        })
      );

      const scanPromise = runScan({
        projectKey: "node-project",
        branch: "main",
        projectDir: "/my/node-app",
        serverUrl: "https://sonar.example.com",
        token: "sonar-tok-012",
        runTests: true,
      });

      // Yield tasks to let the process spawn
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spawnedChildren.length).toBe(1);

      // Emit failure for npm test
      spawnedChildren[0].stderr.emit("data", Buffer.from("Tests Failed Badly"));
      spawnedChildren[0].emit("close", 1);

      const result = await scanPromise;
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stdoutTail).toContain("[TEST RUN FAILURE]");
      expect(result.stderrTail).toContain("Tests Failed Badly");

      // Verify that it only spawned the test runner and did not proceed to sonar-scanner
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });
});

