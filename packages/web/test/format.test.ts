import { describe, expect, it } from "vitest";
import {
  fieldName,
  findingField,
  formatBytes,
  formatDate,
  formatSource,
  formatValue,
  parseSequence,
  paths,
  shortHash,
} from "../src/lib/format";

describe("format helpers", () => {
  it("shortens hashes", () => {
    expect(shortHash("sha256:0123456789abcdef0123")).toBe("0123456789ab");
  });

  it("formats sizes and dates", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatDate("2026-11-27T09:05:33.120Z")).toBe("2026-11-27 09:05 UTC");
    expect(formatDate("not a date")).toBe("not a date");
  });

  it("describes a version's source", () => {
    expect(formatSource({ path: "c/o.json", repository: null, ref: null })).toBe("c/o.json");
    expect(formatSource({ path: "c/o.json", repository: "acme/orders", ref: "main" })).toBe(
      "c/o.json @ main (acme/orders)",
    );
  });

  it("formats values, with absent ones as a dash and long ones cut", () => {
    expect(formatValue(null)).toBe("—");
    expect(formatValue({ type: "string" })).toBe('{"type":"string"}');
    expect(formatValue("x".repeat(400))).toHaveLength(158);
  });

  it("shows one pointer when both sides agree", () => {
    expect(findingField({ oldPointer: "/properties/orderId", newPointer: "/properties/orderId" })).toBe(
      "/properties/orderId",
    );
    expect(findingField({ oldPointer: "", newPointer: "/x" })).toBe("/ → /x");
  });

  it("names the field a pointer ends at", () => {
    expect(fieldName("/properties/orderId")).toBe("orderId");
    expect(fieldName("/properties/a~1b")).toBe("a/b");
    expect(fieldName("/required")).toBeNull();
  });

  it("accepts only positive integer sequences", () => {
    expect(parseSequence("2")).toBe(2);
    for (const bad of ["0", "-1", "01", "1.5", "abc", "99999999999", undefined, ["1"]]) {
      expect(parseSequence(bad)).toBeNull();
    }
  });

  it("builds links", () => {
    expect(paths.version("orders", "orders.created", 3)).toBe("/services/orders/contracts/orders.created/versions/3");
  });
});
