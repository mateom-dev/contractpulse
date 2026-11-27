import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiErrorPanel } from "../src/components/api-error";
import { ConsumerImpactCard, ImpactSummaryBar, impactReason } from "../src/components/consumer-impact";
import { FindingsTable } from "../src/components/findings-table";
import { ApiError } from "../src/lib/api";
import type { ConsumerImpact, Finding } from "../src/lib/types";

const retyped: Finding = {
  rule: "type.changed",
  verdict: "BREAKING",
  direction: "response",
  location: null,
  oldPointer: "/properties/orderId",
  newPointer: "/properties/orderId",
  oldValue: ["string"],
  newValue: ["number"],
  message: "Type changed from string to number; readers expecting string break",
};

const shipping: ConsumerImpact = {
  consumer: { slug: "shipping", name: "Shipping" },
  pinned: { sequence: 1, hash: "sha256:aaaaaaaaaaaaaaaaaaaa", declaredVersion: "1.0.0" },
  uses: ["/properties/orderId"],
  status: "breaking",
  upToDate: false,
  findings: [retyped],
  unrelatedFindings: 2,
  missingPointers: [],
};

describe("FindingsTable", () => {
  const html = renderToStaticMarkup(<FindingsTable findings={[retyped]} caption="Findings" />);

  it("shows the field, rule, direction and both values", () => {
    expect(html).toContain('<strong class="field-name">orderId</strong>');
    expect(html).toContain("/properties/orderId");
    expect(html).toContain("<code>type.changed</code>");
    expect(html).toContain("response");
    expect(html).toContain("[&quot;string&quot;]");
    expect(html).toContain("[&quot;number&quot;]");
    expect(html).toContain("verdict-breaking");
  });

  it("renders nothing without findings", () => {
    expect(renderToStaticMarkup(<FindingsTable findings={[]} caption="Findings" />)).toBe("");
  });
});

describe("ConsumerImpactCard", () => {
  it("links the consumer and its pinned version and explains the status", () => {
    const html = renderToStaticMarkup(
      <ConsumerImpactCard impact={shipping} provider="orders" contract="orders.created" target={2} />,
    );
    expect(html).toContain('id="consumer-shipping"');
    expect(html).toContain('href="/services/shipping"');
    expect(html).toContain('href="/services/orders/contracts/orders.created/versions/1"');
    expect(html).toContain("v1 (1.0.0)");
    expect(html).toContain("compared with v2");
    expect(html).toContain("Breaking");
    expect(html).toContain("type.changed");
  });

  it("marks used fields missing from the target", () => {
    const html = renderToStaticMarkup(
      <ConsumerImpactCard
        impact={{ ...shipping, status: "review", findings: [], missingPointers: ["/properties/orderId"] }}
        provider="orders"
        contract="orders.created"
        target={2}
      />,
    );
    expect(html).toContain('class="pointer missing"');
    expect(html).toContain("Not in v2");
    expect(html).toContain("Needs review");
  });

  it("says when the whole contract is used", () => {
    const html = renderToStaticMarkup(
      <ConsumerImpactCard impact={{ ...shipping, uses: [] }} provider="orders" contract="orders.created" target={2} />,
    );
    expect(html).toContain("the whole contract");
  });
});

describe("impactReason", () => {
  it("counts relevant, missing and unrelated changes", () => {
    expect(impactReason(shipping)).toBe(
      "1 finding touches what it uses. 2 other changes between the versions don't affect it.",
    );
    expect(impactReason({ ...shipping, findings: [], unrelatedFindings: 0, missingPointers: ["/a", "/b"] })).toBe(
      "2 used fields are missing.",
    );
    expect(impactReason({ ...shipping, findings: [], unrelatedFindings: 1, status: "safe" })).toBe(
      "No change touches what it uses. 1 other change between the versions doesn't affect it.",
    );
    expect(impactReason({ ...shipping, upToDate: true })).toBe("Pinned to the same content as this version.");
  });
});

describe("ImpactSummaryBar", () => {
  it("shows counts per status", () => {
    const html = renderToStaticMarkup(<ImpactSummaryBar summary={{ consumers: 3, breaking: 2, review: 0, safe: 1 }} />);
    expect(html).toContain("<strong>3</strong> registered consumers");
    expect(html).toContain("<strong>2</strong> breaking");
    expect(html).toContain("<strong>1</strong> safe");
  });
});

describe("ApiErrorPanel", () => {
  it("explains a missing token", () => {
    const html = renderToStaticMarkup(<ApiErrorPanel error={new ApiError(401, "NO_TOKEN", "not set")} />);
    expect(html).toContain("NO_TOKEN");
    expect(html).toContain("CONTRACTPULSE_API_TOKEN");
  });
});
