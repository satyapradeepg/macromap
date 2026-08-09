import { describe, it, expect } from "vitest";
import { pickDishIcon } from "./dishIcon";

describe("pickDishIcon", () => {
  it("matches smoothie/shake titles", () => {
    expect(pickDishIcon("Chocolate Banana Morning Buzz Smoothie")).toBe("smoothie");
    expect(pickDishIcon("Peanut Butter Protein Shake")).toBe("smoothie");
  });

  it("matches soup/stew/chili/curry titles", () => {
    expect(pickDishIcon("Moosewood Lentil Soup")).toBe("soup");
    expect(pickDishIcon("Hearty Vegetable Stew")).toBe("soup");
    expect(pickDishIcon("Three Bean Chili")).toBe("soup");
    expect(pickDishIcon("Chickpea Curry")).toBe("soup");
  });

  it("matches bowl/salad titles", () => {
    expect(pickDishIcon("Mango Chia Smoothie Bowl")).toBe("smoothie"); // smoothie rule wins, checked first
    expect(pickDishIcon("Quinoa Veggie Bowl")).toBe("bowl");
    expect(pickDishIcon("Mediterranean Chickpea Salad")).toBe("bowl");
  });

  it("matches skillet/scramble/hash/stir-fry titles", () => {
    expect(pickDishIcon("Seitan Breakfast Hash with Potatoes")).toBe("skillet");
    expect(pickDishIcon("Tofu Scramble with Spinach")).toBe("skillet");
    expect(pickDishIcon("Chicken Stir-Fry")).toBe("skillet");
    expect(pickDishIcon("Beef Stir Fry")).toBe("skillet");
    expect(pickDishIcon("Sunday Skillet Breakfast")).toBe("skillet");
  });

  it("matches baked/casserole/gratin/quiche titles", () => {
    expect(pickDishIcon("Baked Ziti")).toBe("baked");
    expect(pickDishIcon("Green Bean Casserole")).toBe("baked");
    expect(pickDishIcon("Potato Gratin")).toBe("baked");
    expect(pickDishIcon("Puff Paste Quiche")).toBe("baked");
  });

  it("matches sandwich/wrap/toast/burger titles", () => {
    expect(pickDishIcon("Turkey Sandwich")).toBe("sandwich");
    expect(pickDishIcon("Black Bean Wrap")).toBe("sandwich");
    expect(pickDishIcon("Avocado Toast")).toBe("sandwich");
    expect(pickDishIcon("Veggie Burger")).toBe("sandwich");
  });

  it("falls back for a title matching no rule", () => {
    expect(pickDishIcon("Seitan and Chickpea Plate with Quinoa")).toBe("fallback");
  });

  it("is case-insensitive", () => {
    expect(pickDishIcon("STRAWBERRY SMOOTHIE")).toBe("smoothie");
  });

  it("matches the plural 'bowls'", () => {
    expect(pickDishIcon("Quinoa Veggie Bowls")).toBe("bowl");
  });
});
