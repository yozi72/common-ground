import { describe, it, expect } from "vitest";
import { runDetectors } from "@/lib/ai/detectors";

describe("deterministic identity detectors (audit: capitalization)", () => {
  it("catches real-name lead-ins in normal sentence capitalization", () => {
    for (const s of ["My name is John", "my name is John Smith", "MY NAME IS John", "Call me Dave.", "I'm Mike, by the way", "I am Sarah", "This is Robert", "My first name is Ana"]) {
      expect(runDetectors(s), s).toContain("real_name");
    }
  });
  it("does not treat ordinary capitalized words after I'm / I am / this is as names", () => {
    for (const s of ["I'm Sorry about that", "I am Glad you asked", "This is Really interesting", "I'm Not sure", "i'm fine thanks", "I am here", "Honestly I'm Tired", "This is the part I like"]) {
      expect(runDetectors(s), s).not.toContain("real_name");
    }
  });
  it("catches employer + location whatever the lead-in's case", () => {
    expect(runDetectors("I work at Boeing in Seattle.")).toContain("employer_location");
    expect(runDetectors("i work for Boeing near Everett")).toContain("employer_location");
    expect(runDetectors("I'm a teacher at Lincoln High, from Dayton")).toContain("employer_location");
    // employer alone, or location alone, is not the combination
    expect(runDetectors("I work at Boeing")).not.toContain("employer_location");
    expect(runDetectors("I live in Seattle")).not.toContain("employer_location");
    // across the sender's recent messages
    expect(runDetectors("I'm in Portland most weeks", ["I work at Nike"])).toContain("employer_location");
  });
  it("needs a capitalized employer (not 'i work at home')", () => {
    expect(runDetectors("I work at home in Denver")).not.toContain("employer_location");
  });
});
