// Deterministic identity/contact detectors. Run server-side before the model.
// They are hints for the model and a floor for the mock provider; they do not
// guarantee detection, and the UI never claims they do.

export type DetectorHit =
  | "email"
  | "phone"
  | "url"
  | "handle"
  | "address"
  | "real_name"
  | "platform_mention"
  | "encoded_contact"
  | "employer_location";

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const SPACED_DIGITS = /(?:\b\d\s+){6,}\d\b/;
const URL = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|me|co|app|gg|tv|us)\b/i;
const HANDLE = /(?:^|\s)@[a-z0-9_.]{3,}/i;
const ADDRESS = /\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|way|pl|place)\b\.?/i;
const ZIP = /\b\d{5}(?:-\d{4})?\b/;
const REAL_NAME = /\b(?:my (?:real |full |last |first )?name(?:'s| is)|i'm|i am|call me|this is)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/;
const PLATFORM = /\b(?:instagram|insta|ig|snap(?:chat)?|tiktok|twitter|x\.com|facebook|fb|telegram|signal|whatsapp|discord|linkedin|venmo|cashapp|reddit|kik|wechat)\b/i;
const ENCODED = /\b(?:\w+\s*(?:\(|\[)?\s*(?:at|AT)\s*(?:\)|\])?\s*\w+\s*(?:\(|\[)?\s*(?:dot|DOT)\s*(?:\)|\])?\s*\w+)\b|\b(?:zero|one|two|three|four|five|six|seven|eight|nine)(?:[\s-]+(?:zero|one|two|three|four|five|six|seven|eight|nine)){5,}\b/;
const EMPLOYER = /\b(?:i work (?:at|for)|my employer is|i'm employed (?:at|by)|i teach at|i'm a nurse at|i'm a doctor at)\s+[A-Z][\w&.-]+/;
const LOCATION = /\b(?:in|near|from)\s+[A-Z][a-z]+(?:,\s*[A-Z]{2})?\b/;

export function runDetectors(body: string, recentFromSender: string[] = []): DetectorHit[] {
  const hits = new Set<DetectorHit>();
  if (EMAIL.test(body)) hits.add("email");
  if (PHONE.test(body) || SPACED_DIGITS.test(body)) hits.add("phone");
  if (URL.test(body)) hits.add("url");
  if (HANDLE.test(body)) hits.add("handle");
  if (ADDRESS.test(body) || (ZIP.test(body) && /\b(?:zip|address|live at)\b/i.test(body))) hits.add("address");
  if (REAL_NAME.test(body)) hits.add("real_name");
  if (PLATFORM.test(body)) hits.add("platform_mention");
  if (ENCODED.test(body)) hits.add("encoded_contact");

  // employer + location across this message and the sender's recent messages
  const combined = [...recentFromSender.slice(-6), body].join("\n");
  if (EMPLOYER.test(combined) && LOCATION.test(combined) && (EMPLOYER.test(body) || LOCATION.test(body))) {
    hits.add("employer_location");
  }
  return [...hits];
}

export const DETECTOR_EXPLANATIONS: Record<DetectorHit, string> = {
  email: "This looks like it contains an email address.",
  phone: "This looks like it contains a phone number.",
  url: "Links aren't shared in these conversations.",
  handle: "This looks like a social media handle.",
  address: "This looks like a street address.",
  real_name: "This looks like it shares a real name. Conversations here stay on a first-alias basis.",
  platform_mention: "Mentions of other messaging platforms can lead to sharing contact details, which isn't available in this pilot.",
  encoded_contact: "This looks like contact details written in a way that avoids filters.",
  employer_location: "Combining where you work with where you live can identify you.",
};

export function hitsAreIdentifying(hits: DetectorHit[]) {
  return hits.some((h) => h !== "platform_mention");
}
