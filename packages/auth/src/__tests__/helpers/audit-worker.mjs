// Plain ESM — deliberately NOT under TypeScript's `include` (tsconfig's
// `include` is ["src"]-relative and excludes `__tests__`), and its name does
// not end in `.test.ts`, so vitest never picks it up as a test file either.
//
// Forked as a real child process by the "AuditLog concurrency / across real
// processes" test in ../audit-log.test.ts, to exercise genuine multi-process
// lock contention that same-process `Promise.all` cannot produce. Imports
// the built library, not the TypeScript source, so `npm run build` must run
// before this worker (or the test that forks it) can be used.
import { AuditLog } from "../../../dist/audit-log.js";

const [, , dir, who, countArg] = process.argv;
const n = Number(countArg);

async function main() {
  const log = new AuditLog({ stream: "s", dir });
  await Promise.all(Array.from({ length: n }, (_, i) => log.append({ who, n: i })));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
