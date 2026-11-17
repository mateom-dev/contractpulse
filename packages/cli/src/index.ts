#!/usr/bin/env node

const USAGE = `Usage: contractpulse <command> [options]

Commands:
  help    Show this message

Compare API and event contract versions and report breaking changes.`;

export function run(argv: readonly string[]): number {
  const [command] = argv;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}\n`);
  return 2;
}

process.exitCode = run(process.argv.slice(2));
