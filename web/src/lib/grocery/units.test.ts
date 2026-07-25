import { describe, it, expect } from "vitest";
import { classifyUnit, toBaseAmount } from "./units";

describe("classifyUnit", () => {
  it("classifies weight units", () => {
    for (const unit of ["g", "gram", "grams", "kg", "kilograms", "oz", "ounces", "lb", "lbs", "pounds"]) {
      expect(classifyUnit(unit)).toBe("weight");
    }
  });

  it("classifies volume units", () => {
    for (const unit of ["ml", "l", "liters", "tsp", "tsps", "Tbsp", "Tbsps", "cup", "cups", "fl oz"]) {
      expect(classifyUnit(unit)).toBe("volume");
    }
  });

  it("classifies unrecognized/descriptor units as other", () => {
    for (const unit of ["can", "bottle", "bag", "loaf", "clove", "cloves", "stalks", "servings", "medium", "large", "large head", "inches", "2-inch", ""]) {
      expect(classifyUnit(unit)).toBe("other");
    }
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(classifyUnit(" G ")).toBe("weight");
    expect(classifyUnit("TSP")).toBe("volume");
  });
});

describe("toBaseAmount", () => {
  it("converts weight units to grams", () => {
    expect(toBaseAmount(2, "kg")).toEqual({ baseAmount: 2000, baseUnit: "g" });
    expect(toBaseAmount(1, "lb")).toEqual({ baseAmount: 453.592, baseUnit: "g" });
    expect(toBaseAmount(100, "g")).toEqual({ baseAmount: 100, baseUnit: "g" });
  });

  it("converts volume units to ml", () => {
    expect(toBaseAmount(1, "l")).toEqual({ baseAmount: 1000, baseUnit: "ml" });
    expect(toBaseAmount(2, "tsp")).toEqual({ baseAmount: 9.85784, baseUnit: "ml" });
    expect(toBaseAmount(1, "cup")).toEqual({ baseAmount: 236.588, baseUnit: "ml" });
  });

  it("returns null for other/descriptor units", () => {
    expect(toBaseAmount(1, "can")).toBeNull();
    expect(toBaseAmount(2, "servings")).toBeNull();
    expect(toBaseAmount(1, "large head")).toBeNull();
  });
});
