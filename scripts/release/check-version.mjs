#!/usr/bin/env node
import { assertMajorReleaseApproval, validateCatalog } from "./release-lib.mjs";

const catalog = validateCatalog();
const majorApproved = assertMajorReleaseApproval(catalog.suiteVersion);
console.log(
  JSON.stringify(
    {
      version: catalog.suiteVersion,
      majorApprovalValidated: majorApproved,
    },
    null,
    2,
  ),
);
