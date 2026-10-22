import { describe, it, expect } from "vitest";
import { runDetectors } from "@/lib/ai/detectors";

// Maintained table of representative phrases for the deterministic identity
// detectors. Expected outcomes are deliberate product decisions, not just what
// the regexes happen to do. These are DETECTOR tests: the model is not involved.
// Heuristic limits are documented in detectors.ts: lowercase or ALL CAPS names
// after weak/medium lead-ins, weak-form names that are ordinary words, other
// scripts, and names without a lead-in are not caught by the detectors alone.
type Row = [phrase: string, realName: boolean, employerLocation?: boolean];
// Strength of lead-in decides what counts as a name (see detectors.ts):
//  strong "my name is X": any case, only the explicit stoplist excludes;
//  medium "call me X": Capitalized or ALL CAPS, explicit stoplist excludes;
//  weak "I'm / I am / it's / this is X": Capitalized only, ordinary words,
//  descriptions, places and dates excluded; ALL CAPS is never evidence.
const TABLE: Row[] = [
  // strong introductions: lowercase, uppercase, mixed, curly apostrophes
  ["My name is John", true],
  ["my name is john", true],                  // strong lead-in: case does not matter
  ["MY NAME IS JOHN", true],
  ["My Name Is Sarah", true],
  ["my name's Priya", true],
  ["my name’s Priya", true],                  // curly apostrophe
  ["MY NAME’S PRIYA", true],
  ["My name: Robert", true],
  ["My name is Mark", true],                  // names that are ordinary words still count after "my name is"
  ["My name is Hope", true],
  ["My name is Will", true],
  ["My name is Grace, by the way", true],
  ["my name is mark", true],
  ["My full name is Priya Natarajan", true],
  ["I'm Christian. My name is John.", true],  // name later in a longer message
  ["My name is secret", false],               // explicit stoplist
  ["my name is secret", false],
  ["My name is Secret", false],
  ["My name is Confidential", false],
  ["My name is private, sorry", false],
  ["my name is not important", false],
  ["my name is irrelevant here", false],
  ["my name is nobody's business", false],
  ["My name is mud today", false],
  ["My name is on the list", false],
  // medium introductions
  ["call me Dave", true],
  ["Call me Dave.", true],
  ["CALL ME DAVE", true],
  ["you can call me Alex", true],
  ["You can call me ALEX", true],
  ["I'm Jewish, by the way. Call me Dave.", true],
  ["call me later", false],
  ["Call me later tonight", false],
  ["Call me Maybe", false],                   // ambiguous song title: not a name
  ["call me anytime", false],
  ["call me crazy, but", false],
  ["call me old-fashioned", false],
  ["Call me when you can", false],
  ["call me dave", false],                    // lowercase after a medium lead-in: not caught (documented limit)
  // weak lead-ins: Capitalized names count
  ["I'm Mike", true],
  ["I’m Mike, by the way", true],
  ["I am Sarah Connor", true],
  ["It was a long day. Anyway, I'm Mike", true],
  ["it's Priya again", true],
  // weak lead-ins: ALL CAPS is shouting, not a name
  ["I'M FURIOUS", false],
  ["I’M FURIOUS", false],
  ["IT'S OVER", false],
  ["IT’S OVER", false],
  ["I AM DYING here", false],
  ["I AM SO DONE", false],
  ["I'M MIKE", false],                        // ALL CAPS after a weak lead-in: not caught (documented limit)
  ["i'm mike", false],                        // lowercase: not caught
  // weak lead-ins: ordinary words, emotions, dates
  ["I am sorry", false],
  ["I'm Sorry about that", false],
  ["I'm Tired of this", false],
  ["I'm Furious about it", false],
  ["It's Over between us", false],
  ["It's Monday again", false],
  ["It's Christmas soon", false],
  ["I'm Hope", false],                        // ordinary word that is also a name: documented limit (weak form)
  ["I'm Dying to know", false],
  ["This is Really hard", false],
  // nationality, religion, politics, places, groups
  ["I'm American", false],
  ["I'M AMERICAN", false],
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
  ["I'm Canadian, from Toronto", false],
  // "this is"
  ["This is Robert, nice to meet you", true],
  ["This is Robert.", true],
  ["This is Texas for you", false],
  ["This is America", false],
  ["THIS IS ROBERT.", false],                 // ALL CAPS after a weak lead-in: not caught (documented limit)
  // employer + location
  ["I work at Boeing in Seattle.", false, true],
  ["i work for Boeing near Everett", false, true],
  ["I WORK AT BOEING in Seattle", false, true],
  ["I work at Boeing. From Boston.", false, true],      // sentence-initial location lead-in
  ["From Boston. I work at Boeing.", false, true],
  ["I'm from Boston and I work at Boeing", false, true],
  ["I work at Boeing. I live in Boston, MA.", false, true],
  ["I'm a nurse at Mercy, from Dayton", false, true],
  ["I work at Boeing", false, false],
  ["I live in Seattle", false, false],
  ["From Boston.", false, false],                       // location alone is not the combination
  ["I work at home in Denver", false, false],
  ["I work at Boeing in general", false, false],
  ["I work at Boeing in March", false, false],
  ["i work at boeing in seattle", false, false],        // lowercase names: too ambiguous for a hint (documented)
];

describe("identity detector phrase table", () => {
  for (const [phrase, name, employer] of TABLE) {
    it(`${JSON.stringify(phrase)} → real_name=${name}${employer !== undefined ? ` employer_location=${employer}` : ""}`, () => {
      const hits = runDetectors(phrase);
      expect(hits.includes("real_name"), phrase).toBe(name);
      if (employer !== undefined) expect(hits.includes("employer_location"), phrase).toBe(employer);
    });
  }
  it("covers at least 90 phrases", () => { expect(TABLE.length).toBeGreaterThanOrEqual(90); });
});
