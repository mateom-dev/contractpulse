import { describe, expect, it } from "vitest";
import { ApiError, apiConfig, createApiClient } from "../src/lib/api";

function recorder(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

const config = { baseUrl: "http://api.test", workspace: "demo", token: "cp_test_token_0000000000000" };

describe("apiConfig", () => {
  it("uses defaults and trims the trailing slash", () => {
    expect(apiConfig({})).toEqual({ baseUrl: "http://127.0.0.1:3001", workspace: "demo", token: null });
    expect(
      apiConfig({
        CONTRACTPULSE_API_URL: " http://registry:4000/ ",
        CONTRACTPULSE_WORKSPACE: "acme",
        CONTRACTPULSE_API_TOKEN: " secret ",
      }),
    ).toEqual({ baseUrl: "http://registry:4000", workspace: "acme", token: "secret" });
  });
});

describe("createApiClient", () => {
  it("sends the bearer token and builds workspace-scoped URLs", async () => {
    const { calls, fetchImpl } = recorder(200, { versions: [] });
    await createApiClient(config, fetchImpl).versions("orders", "orders.created");
    expect(calls[0]?.url).toBe("http://api.test/v1/workspaces/demo/services/orders/contracts/orders.created/versions");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${config.token}`);
    expect(calls[0]?.init?.cache).toBe("no-store");
  });

  it("asks for impact of a given version, or the latest without one", async () => {
    const { calls, fetchImpl } = recorder(200, { consumers: [] });
    const client = createApiClient(config, fetchImpl);
    await client.impact("orders", "orders.created", 2);
    await client.impact("orders", "orders.created");
    expect(calls.map((c) => c.url)).toEqual([
      "http://api.test/v1/workspaces/demo/services/orders/contracts/orders.created/impact?version=2",
      "http://api.test/v1/workspaces/demo/services/orders/contracts/orders.created/impact",
    ]);
  });

  it("encodes path segments", async () => {
    const { calls, fetchImpl } = recorder(200, { service: {} });
    await createApiClient(config, fetchImpl).service("a/../b");
    expect(calls[0]?.url).toBe("http://api.test/v1/workspaces/demo/services/a%2F..%2Fb");
  });

  it("unwraps response envelopes", async () => {
    const { fetchImpl } = recorder(200, { workspace: { id: "w1", slug: "demo", name: "Demo" } });
    expect(await createApiClient(config, fetchImpl).workspace()).toEqual({ id: "w1", slug: "demo", name: "Demo" });
  });

  it("turns error envelopes into ApiError", async () => {
    const { fetchImpl } = recorder(404, { error: { code: "NOT_FOUND", message: "Contract not found" } });
    const error = await createApiClient(config, fetchImpl)
      .versions("orders", "nope")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: "NOT_FOUND", message: "Contract not found" });
  });

  it("reports an unreachable API", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(createApiClient(config, fetchImpl).services()).rejects.toMatchObject({
      status: 502,
      code: "API_UNREACHABLE",
    });
  });

  it("does not call the API without a token", async () => {
    const { calls, fetchImpl } = recorder(200, {});
    await expect(createApiClient({ ...config, token: null }, fetchImpl).services()).rejects.toMatchObject({
      status: 401,
      code: "NO_TOKEN",
    });
    expect(calls).toHaveLength(0);
  });
});
