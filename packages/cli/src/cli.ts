import { parseArgs } from "node:util";
import { ContractError, loadContract, type LoadedContract } from "./contract.js";
import { buildJsonError, buildJsonReport, failsPolicy, formatJson, type FailOn, type JsonError } from "./report/json.js";
import { formatDiff } from "./report/text.js";
import { overallVerdict } from "./rules/finding.js";
import { CompareError, compareContracts } from "./rules/compare.js";

export const USAGE = `Usage: contractpulse <command> [options]

Commands:
  validate <file...>  Check that each file is a supported OpenAPI or JSON Schema contract
  diff <old> <new>    Compare two versions of a contract and explain each change
  help                Show this message

Options for diff:
  --format <text|json>              Output format (default: text)
  --fail-on <breaking|unknown|never>  Lowest verdict that makes diff exit 1 (default: breaking)

Exit codes:
  0  success (validate: every file valid; diff: no finding at or above --fail-on)
  1  validate: a file is invalid; diff: a finding at or above --fail-on
  2  usage error
  3  diff: a file is not a valid contract, or the two cannot be compared

Compare API and event contract versions and report breaking changes.`;

const FORMATS = ["text", "json"] as const;
const FAIL_ON: readonly FailOn[] = ["breaking", "unknown", "never"];

function oneOf<T extends string>(allowed: readonly T[], value: string | undefined, fallback: T): T | undefined {
  if (value === undefined) return fallback;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export interface Output {
  stdout(text: string): void;
  stderr(text: string): void;
}

const processOutput: Output = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

async function validate(files: readonly string[], out: Output): Promise<number> {
  if (files.length === 0) {
    out.stderr(`validate needs at least one file\n\n${USAGE}\n`);
    return 2;
  }

  let failed = 0;
  for (const file of files) {
    try {
      const contract = await loadContract(file);
      const version = contract.contractVersion ?? "unversioned";
      out.stdout(`ok    ${file} (${contract.kind} ${contract.specVersion}, version ${version})\n`);
      out.stdout(`      ${contract.hash}\n`);
      for (const reference of contract.references) {
        if (reference.status !== "local") {
          out.stdout(`      note: $ref ${reference.ref} at ${reference.at || "/"} is ${reference.status} (not resolved)\n`);
        }
      }
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      failed += 1;
      out.stderr(`error ${error.message} [${error.code}]\n`);
    }
  }
  return failed === 0 ? 0 : 1;
}

async function diff(args: readonly string[], out: Output): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: { format: { type: "string" }, "fail-on": { type: "string" } },
    });
  } catch (error) {
    out.stderr(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }

  const format = oneOf(FORMATS, parsed.values.format, "text");
  if (format === undefined) {
    out.stderr(`--format must be one of: ${FORMATS.join(", ")}\n\n${USAGE}\n`);
    return 2;
  }
  const failOn = oneOf(FAIL_ON, parsed.values["fail-on"], "breaking");
  if (failOn === undefined) {
    out.stderr(`--fail-on must be one of: ${FAIL_ON.join(", ")}\n\n${USAGE}\n`);
    return 2;
  }
  const files = parsed.positionals;
  if (files.length !== 2) {
    out.stderr(`diff needs exactly two files: <old> <new>\n\n${USAGE}\n`);
    return 2;
  }

  const errors: JsonError[] = [];
  const loaded: LoadedContract[] = [];
  for (const file of files) {
    try {
      loaded.push(await loadContract(file));
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      errors.push({ file, code: error.code, message: error.message });
    }
  }

  const [previous, next] = loaded;
  if (errors.length === 0 && previous !== undefined && next !== undefined) {
    try {
      const findings = compareContracts(previous, next);
      if (format === "json") {
        out.stdout(formatJson(buildJsonReport(previous, next, findings, failOn)));
      } else {
        out.stdout(formatDiff(previous, next, findings));
      }
      return failsPolicy(overallVerdict(findings), failOn) ? 1 : 0;
    } catch (error) {
      if (!(error instanceof CompareError)) throw error;
      errors.push({ code: "KIND_MISMATCH", message: error.message });
    }
  }

  for (const error of errors) out.stderr(`error ${error.message} [${error.code}]\n`);
  if (format === "json") out.stdout(formatJson(buildJsonError(errors)));
  return 3;
}

/** Run one command and return its exit code; see USAGE for what each code means. */
export async function run(argv: readonly string[], out: Output = processOutput): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    out.stdout(`${USAGE}\n`);
    return 0;
  }
  if (command === "validate") {
    return validate(rest, out);
  }
  if (command === "diff") {
    return diff(rest, out);
  }

  out.stderr(`Unknown command: ${command}\n\n${USAGE}\n`);
  return 2;
}
