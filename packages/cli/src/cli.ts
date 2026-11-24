import { ContractError, loadContract, type LoadedContract } from "./contract.js";
import { formatDiff } from "./report/text.js";
import { CompareError, compareContracts } from "./rules/compare.js";

export const USAGE = `Usage: contractpulse <command> [options]

Commands:
  validate <file...>  Check that each file is a supported OpenAPI or JSON Schema contract
  diff <old> <new>    Compare two versions of a contract and explain each change
  help                Show this message

Compare API and event contract versions and report breaking changes.`;

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

async function diff(files: readonly string[], out: Output): Promise<number> {
  if (files.length !== 2) {
    out.stderr(`diff needs exactly two files: <old> <new>\n\n${USAGE}\n`);
    return 2;
  }

  const loaded: LoadedContract[] = [];
  for (const file of files) {
    try {
      loaded.push(await loadContract(file));
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      out.stderr(`error ${error.message} [${error.code}]\n`);
    }
  }
  const [previous, next] = loaded;
  if (previous === undefined || next === undefined || loaded.length !== 2) return 1;

  try {
    out.stdout(formatDiff(previous, next, compareContracts(previous, next)));
  } catch (error) {
    if (!(error instanceof CompareError)) throw error;
    out.stderr(`error ${error.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * Exit codes: 0 = success (every contract valid, or the comparison ran),
 * 1 = an invalid contract or contracts that cannot be compared, 2 = usage error.
 */
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
