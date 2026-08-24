import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  encodeKeychainBlob,
  decodeKeychainBlob,
  loadKeychain,
  readKeychainRecord,
  writeKeychainRecord,
  setKeychainEntry,
  deleteKeychainEntry,
  KeychainReadError,
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

  it("skips keys that don't match KEYCHAIN_KEY_PATTERN", () => {
    const exec = vi
      .fn()
      .mockReturnValue(encodeKeychainBlob({ "bad-key": "x", RAVEN_TEST_KC_A: "ok" }));

    loadKeychain(exec);

    expect(process.env["RAVEN_TEST_KC_A"]).toBe("ok");
    expect(process.env["bad-key"]).toBeUndefined();
    delete process.env["bad-key"];
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

  it("throws KeychainReadError on a corrupt blob", () => {
    const exec = vi.fn().mockReturnValue("garbage!!");
    expect(() => readKeychainRecord(exec)).toThrow(KeychainReadError);
  });

  it("throws KeychainReadError on a non-not-found failure (status 1)", () => {
    const exec = vi.fn(() => {
      const err = new Error("User interaction is not allowed.");
      Object.assign(err, { status: 1 });
      throw err;
    });
    expect(() => readKeychainRecord(exec)).toThrow(KeychainReadError);
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

  it("rejects an oversized record without calling security -i", () => {
    const exec = vi.fn();
    expect(() => writeKeychainRecord({ BIG: "x".repeat(5000) }, exec)).toThrow(/too large/);
    expect(exec).not.toHaveBeenCalled();
  });
});

/** A fake `security` that keeps one blob in memory across find/add calls. */
function fakeSecurity(initial: Record<string, string> | null) {
  let stored = initial ? encodeKeychainBlob(initial) : null;
  const exec = vi.fn((_cmd: string, args: string[], opts: { input?: string }) => {
    if (args[0] === "find-generic-password") {
      if (stored === null) throw new Error("The specified item could not be found in the keychain.");
      return stored + "\n";
    }
    if (args[0] === "-i") {
      stored = opts.input!.trim().split(" ").pop()!;
      return "";
    }
    throw new Error(`unexpected args ${args.join(" ")}`);
  });
  return { exec, current: () => (stored === null ? null : decodeKeychainBlob(stored)) };
}

describe("setKeychainEntry", () => {
  it("adds a key to an existing record, preserving the others", () => {
    const kc = fakeSecurity({ ATLASSIAN_PASSWORD: "p" });
    setKeychainEntry("RAVEN_DB_PASSWORD_CWM_DEV", "s3cret", kc.exec);
    expect(kc.current()).toEqual({ ATLASSIAN_PASSWORD: "p", RAVEN_DB_PASSWORD_CWM_DEV: "s3cret" });
  });

  it("creates the record when the keychain item does not exist yet", () => {
    const kc = fakeSecurity(null);
    setKeychainEntry("RAVEN_DB_PASSWORD_X", "v", kc.exec);
    expect(kc.current()).toEqual({ RAVEN_DB_PASSWORD_X: "v" });
  });

  it("overwrites an existing value", () => {
    const kc = fakeSecurity({ K: "old" });
    setKeychainEntry("K", "new", kc.exec);
    expect(kc.current()).toEqual({ K: "new" });
  });

  it("rejects an invalid key or empty value without touching the keychain", () => {
    const kc = fakeSecurity({ K: "v" });
    expect(() => setKeychainEntry("bad-key", "v", kc.exec)).toThrow(/key/i);
    expect(() => setKeychainEntry("K", "", kc.exec)).toThrow(/value/i);
    expect(kc.exec).not.toHaveBeenCalled();
  });

  it("propagates a read failure without calling `-i`", () => {
    const exec = vi.fn((_cmd: string, _args: string[], _opts: unknown) => {
      const err = new Error("User interaction is not allowed.");
      Object.assign(err, { status: 1 });
      throw err;
    });
    expect(() => setKeychainEntry("K", "v", exec)).toThrow(KeychainReadError);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![1]).toEqual(
      expect.arrayContaining(["find-generic-password"]),
    );
  });
});

describe("deleteKeychainEntry", () => {
  it("removes the key and returns true", () => {
    const kc = fakeSecurity({ A: "1", B: "2" });
    expect(deleteKeychainEntry("A", kc.exec)).toBe(true);
    expect(kc.current()).toEqual({ B: "2" });
  });

  it("returns false and writes nothing when the key is absent", () => {
    const kc = fakeSecurity({ B: "2" });
    expect(deleteKeychainEntry("A", kc.exec)).toBe(false);
    expect(kc.exec.mock.calls.filter((c) => c[1][0] === "-i")).toHaveLength(0);
  });

  it("returns false when there is no keychain item at all", () => {
    const kc = fakeSecurity(null);
    expect(deleteKeychainEntry("A", kc.exec)).toBe(false);
  });

  it("propagates a read failure without calling `-i`", () => {
    const exec = vi.fn((_cmd: string, _args: string[], _opts: unknown) => {
      const err = new Error("User interaction is not allowed.");
      Object.assign(err, { status: 1 });
      throw err;
    });
    expect(() => deleteKeychainEntry("A", exec)).toThrow(KeychainReadError);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![1]).toEqual(
      expect.arrayContaining(["find-generic-password"]),
    );
  });
});

describe("keychainService validation", () => {
  const original = process.env["RAVEN_KEYCHAIN_SERVICE"];

  afterEach(() => {
    if (original === undefined) delete process.env["RAVEN_KEYCHAIN_SERVICE"];
    else process.env["RAVEN_KEYCHAIN_SERVICE"] = original;
  });

  it("rejects a service name with whitespace before touching exec, but loadKeychain stays silent", () => {
    process.env["RAVEN_KEYCHAIN_SERVICE"] = "raven test";
    const exec = vi.fn();

    expect(() => readKeychainRecord(exec)).toThrow(/RAVEN_KEYCHAIN_SERVICE/);
    expect(() => writeKeychainRecord({ A: "1" }, exec)).toThrow(/RAVEN_KEYCHAIN_SERVICE/);
    expect(exec).not.toHaveBeenCalled();
    expect(() => loadKeychain(exec)).not.toThrow();
  });
});
