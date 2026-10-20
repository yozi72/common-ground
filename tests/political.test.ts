import { describe, it, expect } from "vitest";
import { QUESTIONS, normalize, compareProfiles, answeredCount, optionIndexFromValue, type Answers } from "@/lib/political";

const all = (v: number): Answers => Object.fromEntries(QUESTIONS.map((q) => [q.key, v]));

describe("questionnaire v2 scoring", () => {
  it("normalizes 5-option and 4-option questions to 0..1 and treats an explicit middle as substantive", () => {
    expect(normalize("public_services", 0)).toBe(0);
    expect(normalize("public_services", 2)).toBe(0.5);   // "Stay about the same" is an answer
    expect(normalize("public_services", 4)).toBe(1);
    expect(normalize("abortion", 0)).toBe(0);
    expect(normalize("abortion", 1)).toBeCloseTo(1 / 3);
    expect(normalize("abortion", 3)).toBe(1);
    expect(() => normalize("abortion", 4)).toThrow(); // no invented midpoint
    expect(optionIndexFromValue("abortion", 2 / 3)).toBe(2);
  });

  it("excludes not-sure, declined and untouched questions (they are simply absent from answers)", () => {
    const a: Answers = { public_services: 0, high_income_taxes: 0, healthcare: 0, legal_immigration: 0, deportations: 0 };
    // b answered the same five plus three more; the extras are not shared and do not count
    const b: Answers = { ...all(1) };
    const c = compareProfiles(a, b);
    expect(c.status).toBe("ok");
    expect(c.status === "ok" && c.shared).toBe(5);
    expect(answeredCount(a)).toBe(5);
    // "not sure" is stored elsewhere and never appears here, so it can't act as a midpoint
    expect(Object.values(a).every((v) => v >= 0 && v <= 1)).toBe(true);
  });

  it("requires five shared substantive answers; fewer is insufficient, not agreement", () => {
    const a: Answers = { public_services: 0, high_income_taxes: 0, healthcare: 0, legal_immigration: 0 };
    const b: Answers = { public_services: 1, high_income_taxes: 1, healthcare: 1, legal_immigration: 1, deportations: 1 };
    expect(compareProfiles(a, b)).toEqual({ status: "insufficient", shared: 4 });
    const a5 = { ...a, deportations: 0 };
    expect(compareProfiles(a5, b).status).toBe("ok");
  });

  it("is symmetric; identical = 0, opposing = 1, mixed in between", () => {
    const left = all(0), right = all(1);
    const lr = compareProfiles(left, right), ll = compareProfiles(left, left);
    expect(lr.status === "ok" && lr.score).toBe(1);
    expect(ll.status === "ok" && ll.score).toBe(0);
    const mixed: Answers = { ...all(0.5), abortion: 1 / 3 };
    const ab = compareProfiles(left, mixed), ba = compareProfiles(mixed, left);
    expect(ab).toEqual(ba);
    expect(ab.status === "ok" && ab.score).toBeCloseTo((7 * 0.5 + 1 / 3) / 8, 3);
    // "somewhat" vs "somewhat" on opposite sides (.25 vs .75) averages 0.5
    const s1 = all(0.25), s2 = all(0.75);
    const ss = compareProfiles(s1, s2);
    expect(ss.status === "ok" && ss.score).toBe(0.5);
  });

  it("never compares across questionnaire versions", () => {
    expect(compareProfiles(all(0), all(1), 1, 2)).toEqual({ status: "insufficient", shared: 0 });
  });

  it("per-issue distances are retained", () => {
    const c = compareProfiles(all(0), { ...all(1), climate: 0.25 });
    expect(c.status === "ok" && c.perIssue.climate).toBe(0.25);
    expect(c.status === "ok" && c.perIssue.abortion).toBe(1);
  });
});
