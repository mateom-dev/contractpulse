/**
 * Library entry point: the contract loader, hashing and comparison rules used by
 * the CLI, for other packages (the registry API) that must give the same answers.
 */
export { ContractError, MAX_CONTRACT_BYTES, loadContract, parseContract } from "./contract.js";
export type { ContractErrorCode, ContractKind, LoadedContract } from "./contract.js";
export { DEFAULT_LIMITS } from "./engine/bounds.js";
export type { ParseLimits } from "./engine/bounds.js";
export { canonicalJson, canonicalize, contractHash } from "./engine/canonical.js";
export { getAtPointer, resolveRef } from "./engine/refs.js";
export { CompareError, compareContracts } from "./rules/compare.js";
export { overallVerdict } from "./rules/finding.js";
export type { Direction, Finding, RuleId, Verdict } from "./rules/finding.js";
export { VERDICT_ORDER, jsonFinding } from "./report/json.js";
export type { JsonFinding } from "./report/json.js";
