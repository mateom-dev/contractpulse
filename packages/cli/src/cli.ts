import { ContractError, loadContract } from "./contract.js";

export const USAGE = `Usage: contractpulse <command> [options]

Commands:
  validate <file...>  Check that each file is a supported OpenAPI or JSON Schema contract
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

/** Exit codes: 0 = all valid, 1 = at least one invalid contract, 2 = usage error. */
export async function run(argv: readonly string[], out: Output = processOutput): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    out.stdout(`${USAGE}\n`);
    return 0;
  }
  if (command === "validate") {
    return validate(rest, out);
  }

  out.stderr(`Unknown command: ${command}\n\n${USAGE}\n`);
  return 2;
}
