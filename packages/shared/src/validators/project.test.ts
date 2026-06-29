import { describe, expect, it } from "vitest";
import { updateProjectSchema } from "./project.js";

describe("updateProjectSchema productionUrl", () => {
  it("accepts a valid https url", () => {
    expect(updateProjectSchema.parse({ productionUrl: "https://seasidehoa.com" }).productionUrl)
      .toBe("https://seasidehoa.com");
  });
  it("accepts null/empty", () => {
    expect(updateProjectSchema.parse({ productionUrl: null }).productionUrl).toBeNull();
  });
  it("rejects a non-url string", () => {
    expect(() => updateProjectSchema.parse({ productionUrl: "not a url" })).toThrow();
  });
});
