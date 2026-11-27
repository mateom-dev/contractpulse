import { fieldName, findingField, formatValue } from "../lib/format";
import type { Finding } from "../lib/types";
import { VerdictBadge } from "./badges";

/**
 * Findings with the exact field, rule and values, one row each, in the order
 * the API sends them (BREAKING first).
 */
export function FindingsTable({ findings, caption }: { findings: readonly Finding[]; caption: string }) {
  if (findings.length === 0) return null;
  return (
    <table className="findings">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Verdict</th>
          <th scope="col">Field</th>
          <th scope="col">Rule</th>
          <th scope="col">Direction</th>
          <th scope="col">Before</th>
          <th scope="col">After</th>
        </tr>
      </thead>
      <tbody>
        {findings.map((finding, index) => {
          const name = fieldName(finding.newPointer) ?? fieldName(finding.oldPointer);
          return (
            <tr key={`${finding.rule}:${finding.oldPointer}:${finding.newPointer}:${index}`} data-rule={finding.rule}>
              <td>
                <VerdictBadge verdict={finding.verdict} />
              </td>
              <td>
                {name && <strong className="field-name">{name}</strong>}
                <code className="pointer">{findingField(finding)}</code>
                {finding.location && <span className="muted location">{finding.location}</span>}
              </td>
              <td>
                <code>{finding.rule}</code>
                <span className="message">{finding.message}</span>
              </td>
              <td>{finding.direction}</td>
              <td>
                <code className="value">{formatValue(finding.oldValue)}</code>
              </td>
              <td>
                <code className="value">{formatValue(finding.newValue)}</code>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
