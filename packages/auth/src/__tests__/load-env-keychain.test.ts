import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  encodeKeychainBlob,
  decodeKeychainBlob,
  loadKeychain,
  readKeychainRecord,
  writeKeychainRecord,
} from "../load-env.js";

const TEST_KEYS = ["RAVEN_TEST_KC_A", "RAVEN_TEST_KC_B", "RAVEN_KEYCHAIN_SERVICE"];

describe("keychain blob codec", () => {
  it("round-trips a record through base64 JSON", () => {
    const record = { ATLASSIAN_BASE_URL: "https://x", ATLASSIAN_PASSWORD: "p=w:d\n!" };
    expect(decodeKeychainBlob(encodeKeychainBlob(record))).toEqual(record);
  });

  it("drops non-string values when decoding", () => {
    const b64 = Buffer.from(JSON.stringify({ A: "ok", B: 42, C: null })).toString("base64");
    expect(decodeKeychainBlob(b64)).toEqual({ A: "ok" });
  });

  it("throws on a malformed blob", () => {
    expect(() => decodeKeychainBlob("not-valid-base64-json")).toThrow();
  });
});

describe("loadKeychain", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of TEST_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of TEST_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("queries the login keychain via /usr/bin/security and sets unset vars", () => {
    const blob = encodeKeychainBlob({ RAVEN_TEST_KC_A: "secret-a" });
    const exec = vi.fn().mockReturnValue(`${blob}\n`);

    loadKeychain(exec);

    const [cmd, args] = exec.mock.calls[0];
    expect(cmd).toBe("/usr/bin/security");
    expect(args).toEqual(["find-generic-password", "-s", "raven", "-a", "credentials", "-w"]);
    expect(process.env["RAVEN_TEST_KC_A"]).toBe("secret-a");
  });

  it("never overwrites variables that are already set", () => {
    process.env["RAVEN_TEST_KC_A"] = "explicit-wins";
    const exec = vi
      .fn()
      .mockReturnValue(encodeKeychainBlob({ RAVEN_TEST_KC_A: "from-keychain", RAVEN_TEST_KC_B: "b" }));

    loadKeychain(exec);

    expect(process.env["RAVEN_TEST_KC_A"]).toBe("explicit-wins");
    expect(process.env["RAVEN_TEST_KC_B"]).toBe("b");
  });

  it("honours the RAVEN_KEYCHAIN_SERVICE override", () => {
    process.env["RAVEN_KEYCHAIN_SERVICE"] = "raven-test";
    const exec = vi.fn().mockReturnValue(encodeKeychainBlob({}));

    loadKeychain(exec);

    const [, args] = exec.mock.calls[0];
    expect(args).toContain("raven-test");
    expect(args).not.toContain("raven");
  });

  it("silently no-ops when the keychain item does not exist", () => {
    const exec = vi.fn(() => {
      throw new Error("The specified item could not be found in the keychain.");
    });

    expect(() => loadKeychain(exec)).not.toThrow();
    expect(process.env["RAVEN_TEST_KC_A"]).toBeUndefined();
  });

  it("silently no-ops on a corrupt blob", () => {
    const exec = vi.fn().mockReturnValue("garbage!!");

    expect(() => loadKeychain(exec)).not.toThrow();
    expect(process.env["RAVEN_TEST_KC_A"]).toBeUndefined();
  });
});


describe("readKeychainRecord", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of TEST_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of TEST_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("decodes the stored blob", () => {
    const exec = vi.fn().mockReturnValue(encodeKeychainBlob({ A: "1", B: "2" }) + "\n");
    expect(readKeychainRecord(exec)).toEqual({ A: "1", B: "2" });
    const [cmd, args] = exec.mock.calls[0];
    expect(cmd).toBe("/usr/bin/security");
    expect(args).toEqual(["find-generic-password", "-s", "raven", "-a", "credentials", "-w"]);
  });

  it("returns null when the item is missing", () => {
    const exec = vi.fn(() => {
      throw new Error("The specified item could not be found in the keychain.");
    });
    expect(readKeychainRecord(exec)).toBeNull();
  });

  it("returns null on a corrupt blob", () => {
    const exec = vi.fn().mockReturnValue("garbage!!");
    expect(readKeychainRecord(exec)).toBeNull();
  });
});

describe("writeKeychainRecord", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of TEST_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of TEST_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("writes via `security -i` with the blob on stdin, never in argv", () => {
    const exec = vi.fn().mockReturnValue("");
    writeKeychainRecord({ A: "1" }, exec);
    const [cmd, args, opts] = exec.mock.calls[0];
    expect(cmd).toBe("/usr/bin/security");
    expect(args).toEqual(["-i"]);
    const line = (opts as { input: string }).input;
    expect(line).toMatch(/^add-generic-password -U -s raven -a credentials -w \S+\n$/);
    const blob = line.trim().split(" ").pop()!;
    expect(decodeKeychainBlob(blob)).toEqual({ A: "1" });
    expect(args.join(" ")).not.toContain(blob);
  });

  it("honours RAVEN_KEYCHAIN_SERVICE", () => {
    process.env["RAVEN_KEYCHAIN_SERVICE"] = "raven-test";
    const exec = vi.fn().mockReturnValue("");
    writeKeychainRecord({}, exec);
    const [, , opts] = exec.mock.calls[0];
    expect((opts as { input: string }).input).toContain("-s raven-test -a credentials");
  });

  it("propagates a failure from security", () => {
    const exec = vi.fn(() => {
      throw new Error("User interaction is not allowed.");
    });
    expect(() => writeKeychainRecord({ A: "1" }, exec)).toThrow(/User interaction/);
  });
});
