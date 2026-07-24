import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractPriceCents, lookupIngredientPrice, TavilyQuotaError, TavilyRequestError } from "./tavily";

describe("extractPriceCents", () => {
  it("extracts a plain dollar amount", () => {
    expect(extractPriceCents("Chicken breast averages $3.99 per pound at most stores.")).toBe(399);
  });

  it("extracts a dollar amount with a space after the sign", () => {
    expect(extractPriceCents("Around $ 2.50 per unit.")).toBe(250);
  });

  it("does not match a bare unlabeled number", () => {
    expect(extractPriceCents("Chicken breast averages 3.99 per pound.")).toBeNull();
  });

  it("returns null for an answer with no price at all", () => {
    expect(extractPriceCents("Prices vary widely by region and season.")).toBeNull();
  });

  it("returns null for a non-positive amount", () => {
    expect(extractPriceCents("It costs $0 in this promotion.")).toBeNull();
  });
});

describe("lookupIngredientPrice", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.TAVILY_API_KEY;

  beforeEach(() => {
    process.env.TAVILY_API_KEY = "test-key";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.TAVILY_API_KEY = originalKey;
  });

  it("returns a resolved price when Tavily's answer contains a dollar amount", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ answer: "Ground beef runs about $5.49 per pound." }),
    }) as unknown as typeof fetch;

    const result = await lookupIngredientPrice("ground beef", "US");
    expect(result).toEqual({ priceCents: 549 });
  });

  it("sends the API key as a Bearer token, not a query param", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ answer: "$1.00" }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await lookupIngredientPrice("rice", "US");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.tavily.com/search");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-key" });
  });

  it("returns null when Tavily returns no answer", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    expect(await lookupIngredientPrice("saffron", "US")).toBeNull();
  });

  it("returns null when Tavily's answer has no extractable price", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ answer: "Prices vary by region." }),
    }) as unknown as typeof fetch;

    expect(await lookupIngredientPrice("saffron", "US")).toBeNull();
  });

  it("throws TavilyQuotaError on HTTP 429", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 }) as unknown as typeof fetch;

    await expect(lookupIngredientPrice("rice", "US")).rejects.toThrow(TavilyQuotaError);
  });

  it("throws TavilyRequestError on a non-ok, non-429 response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;

    await expect(lookupIngredientPrice("rice", "US")).rejects.toThrow(TavilyRequestError);
  });

  it("throws TavilyRequestError when the API key is missing", async () => {
    delete process.env.TAVILY_API_KEY;
    await expect(lookupIngredientPrice("rice", "US")).rejects.toThrow(TavilyRequestError);
  });

  it("throws TavilyRequestError when fetch itself fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    await expect(lookupIngredientPrice("rice", "US")).rejects.toThrow(TavilyRequestError);
  });
});
