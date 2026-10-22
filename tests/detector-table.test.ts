import { describe, it, expect } from "vitest";
import { runDetectors } from "@/lib/ai/detectors";

// Maintained table of representative phrases for the deterministic identity
// detectors. Expected outcomes are deliberate product decisions, not just what
// the regexes happen to do. These are DETECTOR tests: the model is not involved.
// Heuristic limits are documented in detectors.ts (lowercase names, names that
// are ordinary words, other scripts are not caught by the detectors alone).
type Row = [phrase: string, realName: boolean, employerLocation?: boolean];
const TABLE: Row[] = [
  // explicit lead-ins, any case
  ["My name is John", true],
  ["my name is john", false],                 // lowercase: not caught (documented limit)
  ["MY NAME IS JOHN", true],
  ["My Name Is Sarah", true],
  ["my name's Priya", true],
  ["my name’s Priya", true],                  // curly apostrophe
  ["My name: Robert", true],
  ["call me Dave", true],
  ["Call me Dave.", true],
  ["CALL ME DAVE", true],
  ["call me later", false],
  ["Call me later tonight", false],
  ["Call me Maybe", false],                   // ambiguous song title: not a name
  ["call me anytime", false],
  ["you can call me Alex", true],
  ["my name is secret", false],
  ["My name is Secret", false],
  ["My name is Confidential", false],
  ["My name is private, sorry", false],
  // weak lead-ins
  ["I'm Mike", true],
  ["I’m Mike, by the way", true],
  ["I'M MIKE", true],
  ["i'm mike", false],                        // lowercase: not caught
  ["I am Sarah Connor", true],
  ["I am sorry", false],
  ["I'm Sorry about that", false],
  ["I'm Tired of this", false],
  ["I'm Hope", false],                        // ordinary word that is also a name: documented limit
  // nationality, religion, politics, places, groups
  ["I'm American", false],
  ["I'm Native American", false],
  ["I'm Christian", false],
  ["I'm Roman Catholic", false],
  ["I'm Jewish", false],
  ["I'm Muslim and my wife is Buddhist", false],
  ["I'm Republican", false],
  ["I am Democrat through and through", false],
  ["I'm Libertarian, mostly", false],
  ["I'm Texan", false],
  ["I'm Black", false],
  ["I'm Gen X", false],
  ["I'm Army, 12 years", false],
  // "this is"
  ["This is Robert, nice to meet you", true],
  ["This is Robert.", true],
  ["This is Texas for you", false],
  ["This is Really hard", false],
  ["This is America", false],
  // name later in a longer message
  ["I'm Christian. My name is John.", true],
  ["I'm Jewish, by the way. Call me Dave.", true],
  ["It was a long day. Anyway, I'm Mike", true],
  // employer + location
  ["I work at Boeing in Seattle.", false, true],
  ["i work for Boeing near Everett", false, true],
  ["I WORK AT BOEING in Seattle", false, true],
  ["I work at Boeing", false, false],
  ["I live in Seattle", false, false],
  ["I work at home in Denver", false, false],
  ["I work at Boeing in general", false, false],
  ["I'm a nurse at Mercy, from Dayton", false, true],
  ["i work at boeing in seattle", false, false],   // lowercase brand: too ambiguous for a hint (documented)
];

describe("identity detector phrase table", () => {
  for (const [phrase, name, employer] of TABLE) {
    it(`${JSON.stringify(phrase)} → real_name=${name}${employer !== undefined ? ` employer_location=${employer}` : ""}`, () => {
      const hits = runDetectors(phrase);
      expect(hits.includes("real_name"), phrase).toBe(name);
      if (employer !== undefined) expect(hits.includes("employer_location"), phrase).toBe(employer);
    });
  }
  it("covers at least 40 phrases", () => { expect(TABLE.length).toBeGreaterThanOrEqual(40); });
});
