#!/usr/bin/env node
// The standalone runner daemon for other machines. It connects outbound to the board server,
// advertises capabilities, and executes dispatched turns. Phase 7 delivers it; until then the
// board server's embedded runner is the only runner.
console.error(
  "stellaris-runner: the standalone runner daemon arrives in Phase 7. See PLAN.md section 7.",
);
process.exitCode = 2;
