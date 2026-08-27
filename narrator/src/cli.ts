#!/usr/bin/env node
/**
 * CLI entry point — a thin bootstrap whose only job is to turn "a sibling
 * package is not built yet" into an actionable message instead of a bare
 * ERR_MODULE_NOT_FOUND. The real CLI lives in `./cliMain.ts`; loading it
 * dynamically is what makes the failure catchable (static imports would
 * fail before any code runs).
 */
async function bootstrap(): Promise<number> {
  try {
    const { main } = await import("./cliMain.js");
    return await main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/workflow-(preprocessor|recommender)/.test(message) && /find|resolve/i.test(message)) {
      console.error(
        [
          "The sibling workflow-preprocessor / workflow-recommender packages are not installed/built yet.",
          "From the narrator folder, run:",
          "",
          "  npm run setup",
          "",
          "(builds ../preprocessor and ../recommender, then installs this package's dependencies)",
        ].join("\n"),
      );
      return 1;
    }
    throw err;
  }
}

// Set the exit code instead of calling process.exit(): on Windows, stdout
// writes are asynchronous and process.exit() can truncate unflushed output.
bootstrap().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
