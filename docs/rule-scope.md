# Initial rule scope

This document fixes which contract changes ContractPulse will classify in its first engine release (Weeks 2–3 of the roadmap), and how. Anything not listed here is reported as **UNKNOWN**; the engine never guesses.

## Inputs

| Format | Versions accepted | Where it is checked |
|---|---|---|
| OpenAPI | 3.0.x, 3.1.x (JSON only) | `packages/cli/src/contract.ts` |
| JSON Schema | draft-07, 2019-09, 2020-12 (JSON only) | `packages/cli/src/contract.ts` |

- Files are read from disk only. Remote `$ref`s are never fetched; a remote reference is an UNKNOWN finding, not an error.
- Files over 1 MiB are rejected before parsing (`TOO_LARGE`).
- Bounded parsing (`packages/cli/src/engine/bounds.ts`) rejects a contract with `LIMIT_EXCEEDED` when it nests deeper than 64 levels (checked on the raw text before `JSON.parse`), holds more than 100,000 values, or has a string or key longer than 64 KiB.
- Local `$ref`s (`#/...`) are resolved with at most 32 hops (`packages/cli/src/engine/refs.ts`). A local `$ref` whose target does not exist is an error (`BROKEN_REF`); cycles, over-long chains and remote refs are kept as references and reported as UNKNOWN by the rules.
- Every loaded contract gets a content hash (`sha256:<hex>`, `packages/cli/src/engine/canonical.ts`) of its canonical form: object keys sorted, `required` and `type` arrays and `enum` values treated as sets, no whitespace. Other arrays keep their order, examples, defaults and `x-` extensions are only key-sorted, and descriptions count. Equivalent files therefore hash the same (see `fixtures/equivalent/`), and an unchanged hash means there is nothing to diff.
- YAML, Swagger 2.0, AsyncAPI and Protobuf are out of scope for now.

## Verdicts

| Verdict | Meaning |
|---|---|
| **SAFE** | Every reader that accepted the old contract also accepts data under the new one, in the direction being checked. |
| **BREAKING** | There is a concrete value that was valid before and is invalid now (or the reverse, depending on direction). |
| **UNKNOWN** | The schema alone cannot settle it. CI defers to a reviewer. |

A run's overall verdict is the worst of its findings: BREAKING > UNKNOWN > SAFE.

## Direction

Compatibility depends on who writes the data and who reads it.

| Position | Writer | Reader | A change breaks when… |
|---|---|---|---|
| Request body / parameters | consumer | producer | the new schema **rejects** something the old one accepted |
| Response body | producer | consumer | the new schema **allows** something the old one did not guarantee |
| Event payload (JSON Schema) | producer | consumer | same as response |

Each finding records its direction (`request` or `response`); event schemas are always checked as `response`.

## Rules in the first release

Field paths use JSON Pointer (e.g. `/properties/orderId`).

| Rule ID | Change | Request | Response / event |
|---|---|---|---|
| `type.changed` | `type` changed to an unrelated type (e.g. `string` → `number`) | BREAKING | BREAKING |
| `type.widened` | type set grows (e.g. `integer` → `number`, `string` → `["string","null"]`) | SAFE | BREAKING |
| `type.narrowed` | type set shrinks (e.g. `number` → `integer`) | BREAKING | SAFE |
| `field.removed` | property removed from `properties` | SAFE¹ | BREAKING |
| `field.added.optional` | new optional property | SAFE | SAFE² |
| `field.added.required` | new property in `required` | BREAKING | SAFE |
| `required.added` | existing property becomes required | BREAKING | SAFE |
| `required.removed` | required property becomes optional | SAFE | BREAKING |

¹ Unless `additionalProperties: false`, in which case clients that still send the field are rejected: BREAKING.
² Unless the old schema had `additionalProperties: false` and consumers validate strictly; reported as SAFE with a note, since the engine cannot see consumer validators.

Each finding carries: rule ID, verdict, direction, JSON Pointer in the old and new document, and the old and new value.

### How the engine applies the rules

`compareContracts` (`packages/cli/src/rules/compare.ts`) returns no findings when the two content hashes match. Otherwise it pairs schemas that exist in both versions and walks them (`packages/cli/src/rules/walk.ts`):

- JSON Schema: the root schema, as `response`.
- OpenAPI: for each operation present in both versions, parameter schemas matched by `in` + `name` (operation-level overrides path-level) and the `application/json` request body as `request`; each `application/json` response with the same status code as `response`.
- From each pair the walker descends into properties present in both versions, `items` and schema-valued `additionalProperties`, following local `$ref`s. A pair already visited in the same direction is skipped, so recursive schemas terminate. Findings come out in a stable order (sorted paths, statuses, parameter keys and property names).

Type rules (`packages/cli/src/rules/type-change.ts`) compare type sets: the `type` keyword (string or array), plus `null` when the OpenAPI 3.0 `nullable: true` is set; `integer` counts as a subset of `number`, and a schema without `type` accepts every type. Equivalent sets such as `["number", "integer"]` and `"number"` produce no finding.

Anything in the UNKNOWN list below that differs between the versions is reported as rule `schema.unsupported` with verdict UNKNOWN. For composition keywords the walker does not descend further, and an unchanged composite that contains a `$ref` is still UNKNOWN, because the referenced schema may have changed.

## Reported as UNKNOWN for now

- `oneOf`, `anyOf`, `allOf`, `not`, `if` / `then` / `else`, `discriminator`
- `$ref` that leaves the document, or reference cycles
- `patternProperties`, `dependentRequired`, `dependentSchemas`, `unevaluatedProperties`
- Changes to `pattern`, `format`, numeric and length bounds, and `enum` values
- Changes to parameter `style` / `explode`, security schemes, and content types other than `application/json`

These move into the rule table only with golden tests that cover the SAFE, BREAKING and UNKNOWN cases for each one (Week 6).

## Worked example

The demo change from `fixtures/contracts/orders.created.v1.schema.json` to `fixtures/changes/orders.created.v2.schema.json`:

| Change | Rule | Verdict |
|---|---|---|
| `orderId`: `string` → `number` | `type.changed` | BREAKING |
| `customerId` removed | `field.removed` (and `required.removed`) | BREAKING |
| `channel` gains a new enum value | — | UNKNOWN (enum rules not in scope yet) |

## Open question

Which decisions can be inferred from schemas alone, and when should CI defer to a reviewer? The current answer is the table above: only structural type, presence and requiredness changes are decided automatically. This will be revisited, and recorded as an ADR, once the golden tests exist.
