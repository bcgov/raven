import { describe, expect, it } from "vitest";
import { assertSafeServerBasePath, assertSafeServerIdentifier } from "../shell.js";

describe("assertSafeServerBasePath", () => {
  it.each([
    "/", "/apps_ux", "/apps_ux/", "/apps_ux/logs", "/opt/apps",
    "/sw_ux/oracle/ofm", "/sw_ux/httpd01/logs", "/Apps/Tomcat-9.0_1",
    "/apps/.hidden", "/apps/a..b", "/apps//logs/",
  ])("accepts the unchanged absolute base path %j", (path) => {
    expect(() => assertSafeServerBasePath(path, "appsBase")).not.toThrow();
  });

  it.each([
    "", "apps_ux", "./apps_ux", "../apps_ux", "/.", "/..", "/apps/./logs",
    "/apps/../logs", "/apps/.", "/apps/..", "/apps/../", "/apps/a b",
    "/apps\tlogs", "/apps\n", "/apps\r", "/apps\0", "/apps\u007f",
    "/apps|id", "/apps;id", "/apps&whoami", "/apps/$(id)", "/apps/`id`",
    "/apps/'quoted'", '/apps/"quoted"', "/apps\\logs", "/apps/*", "/apps/?",
    "/apps/[ab]", "/apps/{a,b}", "/apps>out", "/apps<in", "/apps/café",
  ])("rejects unsafe base path %j with its field label", (path) => {
    expect(() => assertSafeServerBasePath(path, "logsBase")).toThrow(/logsBase/);
  });
});

describe("assertSafeServerIdentifier", () => {
  it.each(["RRS", "rrs-api", "api_v2", "service.xml", "1component", "a..b", "_api", "-api"])("accepts existing identifier grammar %j", (identifier) => {
    expect(() => assertSafeServerIdentifier(identifier, "Component")).not.toThrow();
  });

  it.each([
    "", ".", "..", ".hidden", "app/component", "app\\component",
    "app name", "app\tname", "app\n", "app\r", "app\0", "app|id", "app;id",
    "app$(id)", "app`id`", "app'quote", 'app"quote', "app*", "café",
  ])("rejects unsafe identifier %j with its field label", (identifier) => {
    expect(() => assertSafeServerIdentifier(identifier, "App")).toThrow(/App/);
  });
});
