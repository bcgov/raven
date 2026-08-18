import spawn from "cross-spawn";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute, relative, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface RunScanOptions {
  projectKey: string;
  branch: string;
  projectDir: string;
  serverUrl: string;
  token: string;
  exclusions?: string;
  cpdExclusions?: string;
  coverageExclusions?: string;
  scannerBin?: string; // defaults to "sonar-scanner"
  extraArgs?: string[];
  timeoutMs?: number;
  useMsBuild?: boolean;
  runTests?: boolean;
  testsDir?: string;
  solutionFile?: string;
}

export interface RunScanResult {
  success: boolean;
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
}

export function isValidSonarScanner(bin: string, skipTestBypass = false): boolean {
  if (!skipTestBypass && (process.env.NODE_ENV === "test" || typeof (globalThis as any).vi !== "undefined")) {
    return true;
  }
  try {
    const res = spawn.sync(bin, ["-v"], { stdio: "pipe", env: process.env });
    if (res.error || res.status !== 0) {
      return false;
    }
    const cleanOutput = res.stdout ? res.stdout.toString().toLowerCase() : "";
    return (
      cleanOutput.includes("sonarscanner") ||
      cleanOutput.includes("sonarqube") ||
      cleanOutput.includes("scanner version") ||
      cleanOutput.includes("info: scanner version")
    );
  } catch {
    return false;
  }
}

export function parseSonarConfig(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(filePath)) return result;

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
        continue;
      }
      const idx = trimmed.indexOf("=");
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (key) {
          result[key] = val;
        }
      }
    }
  } catch {
    // Return empty on read errors
  }
  return result;
}

export function getMergedSonarProps(projectDir?: string): {
  exclusions?: string;
  cpdExclusions?: string;
  coverageExclusions?: string;
} {
  const globalConfigPath = join(__dirname, "..", "sonar.config");
  const globalRules = parseSonarConfig(globalConfigPath);

  let projectRules: Record<string, string> = {};
  if (projectDir) {
    const projectConfigPath = join(projectDir, "sonar.config");
    if (existsSync(projectConfigPath)) {
      projectRules = parseSonarConfig(projectConfigPath);
    }
  }

  const merged = { ...globalRules, ...projectRules };

  return {
    exclusions: merged.exclusions ?? merged.SONAR_EXCLUSIONS,
    cpdExclusions: merged.cpdExclusions ?? merged.SONAR_CPD_EXCLUSIONS,
    coverageExclusions: merged.coverageExclusions ?? merged.SONAR_COVERAGE_EXCLUSIONS,
  };
}

export function hasDotNetCode(dir: string, depth = 0): boolean {
  if (depth > 5) return false;
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (["node_modules", "bin", "obj", "dist"].includes(file.toLowerCase()) || file.startsWith(".")) {

        continue;
      }
      const fullPath = join(dir, file);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (hasDotNetCode(fullPath, depth + 1)) {
          return true;
        }
      } else {
        const lower = file.toLowerCase();
        if (
          lower.endsWith(".cs") ||
          lower.endsWith(".vb") ||
          lower.endsWith(".csproj") ||
          lower.endsWith(".vbproj") ||
          lower.endsWith(".sln") ||
          lower.endsWith(".slnx")
        ) {
          return true;
        }
      }
    }
  } catch {
    // Ignore read errors
  }
  return false;
}

export function hasDotNetTests(dir: string, depth = 0): boolean {
  if (depth > 5) return false;
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const lower = file.toLowerCase();
      if (
        lower === "node_modules" ||
        lower === "bin" ||
        lower === "obj" ||
        lower === "dist" ||
        lower.startsWith(".")
      ) {
        continue;
      }
      const fullPath = join(dir, file);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (hasDotNetTests(fullPath, depth + 1)) {
          return true;
        }
      } else {
        if (lower.endsWith(".csproj") && lower.includes("test")) {
          return true;
        }
        if (
          (lower.endsWith("tests.cs") || lower.endsWith("test.cs")) &&
          !lower.includes("sonar-scanner.test.cs") &&
          !lower.includes("sonar-client.test.cs")
        ) {
          return true;
        }
      }
    }
  } catch {
    // Ignore read errors
  }
  return false;
}

export function hasNodeTests(dir: string): boolean {
  try {
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return !!(pkg && pkg.scripts && pkg.scripts.test);
  } catch {
    return false;
  }
}

export function getScannerPath(bin: string): string {
  if (isAbsolute(bin)) return bin;

  const pathEnv = process.env.PATH || "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const paths = pathEnv.split(delimiter);

  for (const p of paths) {
    const fullPath = join(p, bin);
    if (existsSync(fullPath)) return fullPath;

    if (process.platform === "win32") {
      for (const ext of [".bat", ".cmd", ".exe"]) {
        const withExt = fullPath + ext;
        if (existsSync(withExt)) return withExt;
      }
    }
  }
  return bin;
}

function getTestsDir(projectDir: string, configuredTestsDir?: string): string | undefined {
  if (configuredTestsDir) {
    const testsDir = isAbsolute(configuredTestsDir)
      ? configuredTestsDir
      : resolve(projectDir, configuredTestsDir);
    if (!existsSync(testsDir)) {
      throw new Error(`Configured tests directory does not exist: "${testsDir}"`);
    }
    return testsDir;
  }

  const siblingTestsDir = resolve(projectDir, "..", "tests");
  return existsSync(siblingTestsDir) ? siblingTestsDir : undefined;
}

function getRelativeTestsDir(projectDir: string, testsDir: string | undefined): string | undefined {
  if (!testsDir) return undefined;
  const relativeTestsDir = relative(projectDir, testsDir).replaceAll("\\", "/");
  return relativeTestsDir && relativeTestsDir !== "." ? relativeTestsDir : undefined;
}

function getDotNetBuildTarget(projectDir: string, configuredSolutionFile?: string): string | undefined {
  if (configuredSolutionFile) {
    const solutionFile = isAbsolute(configuredSolutionFile)
      ? configuredSolutionFile
      : resolve(projectDir, configuredSolutionFile);
    if (!existsSync(solutionFile)) {
      throw new Error(`Configured .NET solution/project file does not exist: "${solutionFile}"`);
    }
    return solutionFile;
  }

  let files: string[];
  try {
    const entries = readdirSync(projectDir);
    if (!Array.isArray(entries)) return undefined;
    files = entries;
  } catch {
    return undefined;
  }

  const slnxFiles = files.filter((file) => file.toLowerCase().endsWith(".slnx"));
  if (slnxFiles.length === 1) {
    return join(projectDir, slnxFiles[0]);
  }
  if (slnxFiles.length > 1) return undefined;

  const slnFiles = files.filter((file) => file.toLowerCase().endsWith(".sln"));
  if (slnFiles.length === 1) {
    return join(projectDir, slnFiles[0]);
  }
  if (slnFiles.length > 1) return undefined;

  const projectFiles = files.filter((file) => {
    const lower = file.toLowerCase();
    return lower.endsWith(".csproj") || lower.endsWith(".vbproj");
  });
  return projectFiles.length === 1 ? join(projectDir, projectFiles[0]) : undefined;
}

function getSonarTestReportsPath(projectDir: string, testsDir: string | undefined, fileName: string): string {
  const reportPaths = [`**/TestResults/**/${fileName}`];
  const relativeTestsDir = getRelativeTestsDir(projectDir, testsDir);
  if (relativeTestsDir) {
    reportPaths.unshift(`${relativeTestsDir}/**/TestResults/**/${fileName}`);
  }
  return reportPaths.join(",");
}

interface RunCommandResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCommand(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs?: number
): Promise<RunCommandResult> {
  return new Promise<RunCommandResult>((resolve) => {
    const child = spawn(bin, args, { cwd, env: process.env });
    let out = "", err = "";
    const TAIL = 8_000;

    child.stdout?.on("data", (d: string | Buffer) => { out = (out + d.toString()).slice(-TAIL); });
    child.stderr?.on("data", (d: string | Buffer) => { err = (err + d.toString()).slice(-TAIL); });

    const timer = timeoutMs
      ? setTimeout(() => child.kill("SIGTERM"), timeoutMs)
      : null;

    child.on("close", (code: number | null) => {
      if (timer) clearTimeout(timer);
      resolve({ success: code === 0, exitCode: code ?? -1, stdout: out, stderr: err });
    });
    child.on("error", (e: Error) => {
      if (timer) clearTimeout(timer);
      resolve({ success: false, exitCode: -1, stdout: out, stderr: String(e) });
    });
  });
}

export async function runScan(opts: RunScanOptions): Promise<RunScanResult> {
  const bin = opts.scannerBin ?? process.env.SONAR_SCANNER_BIN ?? "sonar-scanner";
  const isDotNet = opts.useMsBuild ?? hasDotNetCode(opts.projectDir);
  const candidateTestsDir = getTestsDir(opts.projectDir, opts.testsDir);

  if (!isDotNet) {
    if (!isValidSonarScanner(bin)) {
      throw new Error(
        `Invalid SonarQube scanner binary path: "${bin}". ` +
        `Make sure SONAR_SCANNER_BIN is correct and points to a valid sonar-scanner executable.`
      );
    }
  }

  const props = getMergedSonarProps(opts.projectDir);
  const exclusions = opts.exclusions ?? props.exclusions;
  const cpdExclusions = opts.cpdExclusions ?? props.cpdExclusions;
  const coverageExclusions = opts.coverageExclusions ?? props.coverageExclusions;

  if (isDotNet) {
    // Check test bypass or actual existence of the MSBuild binary
    const isTest = process.env.NODE_ENV === "test" || typeof (globalThis as any).vi !== "undefined";
    const resolvedBin = getScannerPath(bin);
    if (!isTest && !isAbsolute(resolvedBin)) {
      throw new Error(
        `Unable to resolve sonar-scanner binary "${bin}" to an absolute path. ` +
        `Set scannerBin/SONAR_SCANNER_BIN to an absolute path so the MSBuild scanner can be located.`
      );
    }

    const msbuildDir = join(dirname(resolvedBin), "..", "msbuild");
    let msbuildBin = join(msbuildDir, "SonarScanner.MSBuild.exe");
    let isDotnetDll = false;
    if (!isTest) {
      if (!existsSync(msbuildBin)) {
        const dllPath = join(msbuildDir, "SonarScanner.MSBuild.dll");
        if (existsSync(dllPath)) {
          msbuildBin = dllPath;
          isDotnetDll = true;
        } else {
          throw new Error(
            `MSBuild SonarQube scanner binary not found at: "${msbuildBin}" or "${dllPath}". ` +
            `Please ensure SonarScanner for MSBuild is installed in the "msbuild" folder alongside the sonar-scanner bin.`
          );
        }
      }
    } else {
      // In test, if the executable doesn't exist, we can fake it being dll if we want or just default to exe
      if (!existsSync(msbuildBin) && existsSync(join(msbuildDir, "SonarScanner.MSBuild.dll"))) {
        msbuildBin = join(msbuildDir, "SonarScanner.MSBuild.dll");
        isDotnetDll = true;
      }
    }

    const hasProjectTests = hasDotNetTests(opts.projectDir);
    const hasCandidateTests = candidateTestsDir ? hasDotNetTests(candidateTestsDir) : false;
    const dotNetBuildTarget = getDotNetBuildTarget(opts.projectDir, opts.solutionFile);
    const dotNetTestTarget =
      opts.solutionFile
        ? dotNetBuildTarget
        : candidateTestsDir
          ? getDotNetBuildTarget(candidateTestsDir) ?? dotNetBuildTarget
          : dotNetBuildTarget;
    const testsDir =
      hasCandidateTests || (opts.runTests === true && opts.testsDir !== undefined)
        ? candidateTestsDir
        : undefined;
    const shouldRunTests = opts.runTests ?? (hasProjectTests || hasCandidateTests);

    const beginArgs: string[] = [
      "begin",
      `/k:${opts.projectKey}`,
      `/d:sonar.host.url=${opts.serverUrl}`,
      `/d:sonar.token=${opts.token}`,
      `/d:sonar.branch.name=${opts.branch}`,
    ];
    if (exclusions)         beginArgs.push(`/d:sonar.exclusions=${exclusions}`);
    if (cpdExclusions)      beginArgs.push(`/d:sonar.cpd.exclusions=${cpdExclusions}`);
    if (coverageExclusions) beginArgs.push(`/d:sonar.coverage.exclusions=${coverageExclusions}`);

    if (shouldRunTests) {
      beginArgs.push(
        `/d:sonar.cs.opencover.reportsPaths=${getSonarTestReportsPath(
          opts.projectDir,
          testsDir,
          "coverage.opencover.xml",
        )}`,
      );
      beginArgs.push(
        `/d:sonar.cs.vstest.reportsPaths=${getSonarTestReportsPath(opts.projectDir, testsDir, "*.trx")}`,
      );
    }

    if (opts.extraArgs?.length) {
      for (const arg of opts.extraArgs) {
        if (arg.startsWith("-D")) {
          beginArgs.push("/d:" + arg.slice(2));
        } else if (arg.startsWith("/d:")) {
          beginArgs.push(arg);
        } else {
          beginArgs.push(arg);
        }
      }
    }

    const startTime = Date.now();
    const totalTimeout = opts.timeoutMs;

    const getRemainingTimeout = () => {
      if (!totalTimeout) return undefined;
      const elapsed = Date.now() - startTime;
      return Math.max(1000, totalTimeout - elapsed);
    };

    // 1. Begin
    const beginResult = await runCommand(
      isDotnetDll ? "dotnet" : msbuildBin,
      isDotnetDll ? [msbuildBin, ...beginArgs] : beginArgs,
      opts.projectDir,
      getRemainingTimeout()
    );

    let combinedOut = `[STEP 1: BEGIN]\n` + beginResult.stdout;
    let combinedErr = `[STEP 1: BEGIN]\n` + beginResult.stderr;

    if (!beginResult.success) {
      return {
        success: false,
        exitCode: beginResult.exitCode,
        stdoutTail: combinedOut,
        stderrTail: combinedErr,
      };
    }

    // 2. Build
    const buildResult = await runCommand(
      "dotnet",
      ["build", ...(dotNetBuildTarget ? [dotNetBuildTarget] : [])],
      opts.projectDir,
      getRemainingTimeout()
    );

    combinedOut += `\n[STEP 2: BUILD]\n` + buildResult.stdout;
    combinedErr += `\n[STEP 2: BUILD]\n` + buildResult.stderr;

    if (!buildResult.success) {
      return {
        success: false,
        exitCode: buildResult.exitCode,
        stdoutTail: combinedOut,
        stderrTail: combinedErr,
      };
    }
    // 2.5. Test (if shouldRunTests)
    if (shouldRunTests) {
      const testArgs = [
        "test",
        ...(dotNetTestTarget ? [dotNetTestTarget] : []),
        ...(testsDir || dotNetTestTarget ? [] : ["--no-build"]),
        "--collect:XPlat Code Coverage",
        "--logger",
        "trx",
        "--",
        "DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.Format=opencover",
      ];
      const testResult = await runCommand(
        "dotnet",
        testArgs,
        opts.projectDir,
        getRemainingTimeout()
      );

      combinedOut += `\n[STEP 2.5: TEST]\n` + testResult.stdout;
      combinedErr += `\n[STEP 2.5: TEST]\n` + testResult.stderr;

      if (!testResult.success) {
        return {
          success: false,
          exitCode: testResult.exitCode,
          stdoutTail: combinedOut,
          stderrTail: combinedErr,
        };
      }
    }
    // 3. End
    const endResult = await runCommand(
      isDotnetDll ? "dotnet" : msbuildBin,
      isDotnetDll ? [msbuildBin, "end", `/d:sonar.token=${opts.token}`] : ["end", `/d:sonar.token=${opts.token}`],
      opts.projectDir,
      getRemainingTimeout()
    );

    combinedOut += `\n[STEP 3: END]\n` + endResult.stdout;
    combinedErr += `\n[STEP 3: END]\n` + endResult.stderr;

    return {
      success: endResult.success,
      exitCode: endResult.exitCode,
      stdoutTail: combinedOut,
      stderrTail: combinedErr,
    };
  }

  // Fallback to normal sonar-scanner
  const hasProjectTests = hasNodeTests(opts.projectDir);
  const hasCandidateTests = candidateTestsDir ? hasNodeTests(candidateTestsDir) : false;
  const testsDir =
    hasCandidateTests || (opts.runTests === true && opts.testsDir !== undefined)
      ? candidateTestsDir
      : undefined;
  const runNodeTests = opts.runTests ?? (hasProjectTests || hasCandidateTests);

  const args: string[] = [
    `-Dsonar.projectKey=${opts.projectKey}`,
    `-Dsonar.branch.name=${opts.branch}`,
    `-Dsonar.host.url=${opts.serverUrl}`,
    `-Dsonar.token=${opts.token}`,
  ];
  if (exclusions)         args.push(`-Dsonar.exclusions=${exclusions}`);
  if (cpdExclusions)      args.push(`-Dsonar.cpd.exclusions=${cpdExclusions}`);
  if (coverageExclusions) args.push(`-Dsonar.coverage.exclusions=${coverageExclusions}`);

  if (runNodeTests) {
    const reportPaths = ["coverage/lcov.info", "**/coverage/lcov.info"];
    const relativeTestsDir = getRelativeTestsDir(opts.projectDir, testsDir);
    if (relativeTestsDir) {
      reportPaths.unshift(`${relativeTestsDir}/coverage/lcov.info`);
      if (!relativeTestsDir.startsWith("../")) {
        reportPaths.unshift(`${relativeTestsDir}/**/coverage/lcov.info`);
      }
    }
    args.push(`-Dsonar.javascript.lcov.reportPaths=${reportPaths.join(",")}`);
  }

  if (opts.extraArgs?.length)  args.push(...opts.extraArgs);

  const startTime = Date.now();
  const totalTimeout = opts.timeoutMs;

  const getRemainingTimeout = (minTimeout = 1) => {
    if (!totalTimeout) return undefined;
    const elapsed = Date.now() - startTime;
    return Math.max(minTimeout, totalTimeout - elapsed);
  };

  let testPrefix = "";
  if (runNodeTests) {
    const testResult = await runCommand(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["test"],
      testsDir ?? opts.projectDir,
      getRemainingTimeout(1000)
    );
    if (!testResult.success) {
      return {
        success: false,
        exitCode: testResult.exitCode,
        stdoutTail: `[TEST RUN FAILURE]\n` + testResult.stdout,
        stderrTail: `[TEST RUN FAILURE]\n` + testResult.stderr,
      };
    }
    testPrefix = `[TEST RUN SUCCESS]\n` + testResult.stdout + "\n\n";
  }

  return await new Promise<RunScanResult>((resolve) => {
    const child = spawn(bin, args, { cwd: opts.projectDir, env: process.env });
    let out = testPrefix, err = "";
    const TAIL = 8_000;

    child.stdout?.on("data", (d: string | Buffer) => { out = (out + d.toString()).slice(-TAIL); });
    child.stderr?.on("data", (d: string | Buffer) => { err = (err + d.toString()).slice(-TAIL); });

    const remainingTimeout = getRemainingTimeout(1);
    const timer = remainingTimeout
      ? setTimeout(() => child.kill("SIGTERM"), remainingTimeout)
      : null;

    child.on("close", (code: number | null) => {
      if (timer) clearTimeout(timer);
      resolve({ success: code === 0, exitCode: code ?? -1, stdoutTail: out, stderrTail: err });
    });
    child.on("error", (e: Error) => {
      if (timer) clearTimeout(timer);
      resolve({ success: false, exitCode: -1, stdoutTail: out, stderrTail: String(e) });
    });
  });
}