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

describe("identity detector: descriptions are not names (seventh review)", () => {
  it("does not flag ordinary identity descriptions", () => {
    for (const s of ["I'm American", "I'm Christian", "I'm Republican", "I'm Jewish", "I'm Native American", "I'm Roman Catholic", "I’m Catholic and my wife is Jewish", "This is Texas for you", "I am Canadian, eh", "I'm Gen X", "I'm Black and proud", "I'm Muslim, and it shaped how I see this"]) {
      expect(runDetectors(s), s).not.toContain("real_name");
    }
  });
  it("still catches explicit disclosures, later in the message, and with curly apostrophes", () => {
    for (const s of ["I'm Christian. My name is John.", "I’m Jewish, by the way. Call me Dave.", "my name’s Priya", "I'm American and I'm Mike", "Honestly? I am Sarah Connor", "This is Robert, nice to meet you", "MY NAME IS JOHN".toLowerCase().replace("john", "John")]) {
      expect(runDetectors(s), s).toContain("real_name");
    }
  });
  it("employer + location: lead-ins in any case, generic words excluded", () => {
    expect(runDetectors("i work at boeing in seattle")).not.toContain("employer_location");   // lowercase brand: too ambiguous for a hint
    expect(runDetectors("i work at Boeing in Seattle")).toContain("employer_location");
    expect(runDetectors("I WORK AT BOEING in Seattle")).toContain("employer_location");
    expect(runDetectors("I work at home in Denver")).not.toContain("employer_location");
    expect(runDetectors("I work at Boeing in general")).not.toContain("employer_location");
    expect(runDetectors("I'm a nurse at Mercy, from Dayton")).toContain("employer_location");
    expect(runDetectors("I work for Amazon", ["I live in Tacoma, WA these days"])).toContain("employer_location");
  });
  it("normal personal storytelling passes", () => {
    for (const s of ["I'm Tired of the arguing, honestly.", "I am Hopeful about next year", "This is Really hard to say", "I'm Sorry I disappeared for a bit", "We moved a lot when I was a kid; I'm Still figuring out where home is"]) {
      expect(runDetectors(s), s).not.toContain("real_name");
    }
  });
});
