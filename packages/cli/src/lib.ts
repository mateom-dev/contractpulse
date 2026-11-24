/**
 * Library entry point: the contract loader and hashing used by the CLI, for
 * other packages (the registry API) that must accept exactly the same input.
 */
export { ContractError, MAX_CONTRACT_BYTES, loadContract, parseContract } from "./contract.js";
export type { ContractErrorCode, ContractKind, LoadedContract } from "./contract.js";
export { DEFAULT_LIMITS } from "./engine/bounds.js";
export type { ParseLimits } from "./engine/bounds.js";
export { canonicalJson, canonicalize, contractHash } from "./engine/canonical.js";
