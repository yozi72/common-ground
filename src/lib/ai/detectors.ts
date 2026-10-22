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
const PLATFORM = /\b(?:instagram|insta|ig|snap(?:chat)?|tiktok|twitter|x\.com|facebook|fb|telegram|signal|whatsapp|discord|linkedin|venmo|cashapp|reddit|kik|wechat)\b/i;
const ENCODED = /\b(?:\w+\s*(?:\(|\[)?\s*(?:at|AT)\s*(?:\)|\])?\s*\w+\s*(?:\(|\[)?\s*(?:dot|DOT)\s*(?:\)|\])?\s*\w+)\b|\b(?:zero|one|two|three|four|five|six|seven|eight|nine)(?:[\s-]+(?:zero|one|two|three|four|five|six|seven|eight|nine)){5,}\b/;

// --- real names -------------------------------------------------------------
// Explicit lead-ins ("my name is", "call me") always count when followed by a
// capitalized word. Weak lead-ins ("I'm", "I am", "this is") count only when
// the capitalized word is not an ordinary word, a demonym, a religion, a party
// or another group description: "I'm American", "I'm Catholic", "I'm Republican"
// describe a person, they don't name one. Every lead-in in the message is
// checked, so a name later in a longer message is still caught. Apostrophes
// may be straight or curly; lead-ins are case-insensitive.
const EXPLICIT_NAME = /\b(?:my (?:real |full |last |first |middle )?name(?:'s| is|:)|call me|you can call me|name's)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/gi;
const WEAK_NAME = /\b(?:[Ii]'m|[Ii] am|[Ii]t's)\s+([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?\b/g;
// "This is X" introduces a person only when X stands alone: "This is Robert," / "This is Robert." / "This is Robert here"
const THIS_IS_NAME = /\b[Tt]his is\s+([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?(?=\s*(?:[,.!]|$|\s+(?:here|speaking|btw)\b))/g;
const NOT_NAMES = new Set([
  // ordinary sentence-initial or capitalized words
  "sorry","sure","fine","good","great","okay","ok","not","just","so","really","glad","happy","done","back","still","also","only","very","pretty","kind","curious","interested","thinking","honestly","from","in","at","on","going","trying","here","there","the","a","an","my","your","all","about","what","why","how","it","that","this","new","old","tired","busy","excited","hoping","afraid","worried","mostly","usually","actually","definitely","probably","maybe","always","never","pro","anti","for","against","right","left","wrong","late","early","home","online","off","out","up","down","i","we","they","you","he","she","one","two","three","first","last","alone","lucky","grateful","proud","single","married","divorced","retired","unemployed","disabled","sick","better","worse","fine","ready","open","closed","sad","angry","mad","upset","scared","nervous","hopeful","exhausted","lost","stuck","confused","surprised","shocked","amazed","impressed","thankful","bored","cold","hot","hungry","full","young","older","younger","taller","shorter","big","small","tall","short","deaf","blind","autistic","gay","straight","bi","trans","queer","vegan","vegetarian","sober","religious","spiritual","secular","atheist","agnostic","liberal","conservative","progressive","moderate","libertarian","independent","republican","democrat","democratic","green","socialist","populist","nationalist","patriotic","catholic","protestant","christian","orthodox","evangelical","baptist","methodist","lutheran","presbyterian","pentecostal","mormon","lds","jewish","muslim","hindu","buddhist","sikh","roman","native","american","african","asian","european","latino","latina","latinx","hispanic","black","white","indigenous","mexican","canadian","british","english","irish","scottish","welsh","italian","german","french","spanish","polish","russian","ukrainian","chinese","japanese","korean","vietnamese","filipino","thai","indian","pakistani","arab","persian","iranian","turkish","greek","portuguese","brazilian","cuban","dominican","puerto","nigerian","ethiopian","somali","jamaican","haitian","texan","californian","southern","northern","midwestern","western","eastern","appalachian","rural","urban","suburban","catholic","gen","boomer","millennial","generation","christian","jewish","muslim","army","navy","marine","veteran","military","union","blue","red","purple","team","type","class","middle","working","upper","lower","texas","california","florida","york","ohio","georgia","alaska","hawaii","america","europe","asia","africa","canada","mexico","england","france","germany","italy","spain","china","japan","india","israel","russia","brazil","australia","ireland","scotland","london","paris","chicago","boston","seattle","portland","denver","austin","dallas","houston","miami","atlanta","detroit","phoenix","vegas","philly","brooklyn","jersey","heaven","hell","earth",
]);
function looksLikeRealName(body: string) {
  const text = body.replace(/[‘’ʼ]/g, "'");
  for (const m of text.matchAll(EXPLICIT_NAME)) { if (m[1]) return true; }
  for (const m of [...text.matchAll(WEAK_NAME), ...text.matchAll(THIS_IS_NAME)]) {
    const first = m[1], second = m[2];
    if (NOT_NAMES.has(first.toLowerCase())) {
      // "I'm Native American", "I'm Roman Catholic": the second word is a description too
      continue;
    }
    if (second && NOT_NAMES.has(second.toLowerCase()) && !/^[A-Z][a-z]+$/.test(first)) continue;
    return true;
  }
  return false;
}

// --- employer + location ----------------------------------------------------
// Lead-ins are case-insensitive; the employer must look like a name (capitalized
// or ALL CAPS) and not be a generic word ("I work at home"). A location is
// "in/near/from" + a capitalized place or a "City, ST" pair.
const EMPLOYER = /\b(?:i work (?:at|for)|my employer is|i'm employed (?:at|by)|i teach at|i'm an? [a-z]+ (?:at|for|with))\s+([A-Z][\w&.'-]*|[A-Z]{2,})\b/gi;
const NOT_EMPLOYERS = new Set(["home","a","an","the","my","night","nights","remote","remotely","myself","two","three","several","various","different","many","another","one","this","that","school","work","church","it","there","here","now","least","most","all","some","any","no","our","their","his","her","your","random","small","big","large","local","some","every","each"]);
const LOCATION = /\b(?:in|near|from|outside)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)(?:,\s*[A-Z]{2})?\b|\b(?:in|near|from)\s+[a-z]+,\s*[A-Z]{2}\b/g;
const NOT_PLACES = new Set(["i","my","the","a","an","this","that","it","there","here","january","february","march","april","may","june","july","august","september","october","november","december","monday","tuesday","wednesday","thursday","friday","saturday","sunday","god","jesus","christ","college","school","church","town","case","fact","general","short","summary","person","theory","practice","particular","time","terms","order","addition","spite","front","love","touch","charge","part","full","return"]);
function employerMentioned(text: string) {
  for (const m of text.matchAll(EMPLOYER)) { if (m[1] && !NOT_EMPLOYERS.has(m[1].toLowerCase())) return true; }
  return false;
}
function locationMentioned(text: string) {
  for (const m of text.matchAll(LOCATION)) {
    if (!m[1]) return true;                                   // "city, ST" form
    if (!NOT_PLACES.has(m[1].split(/\s/)[0].toLowerCase())) return true;
  }
  return false;
}

export function runDetectors(body: string, recentFromSender: string[] = []): DetectorHit[] {
  const hits = new Set<DetectorHit>();
  const text = body.replace(/[‘’ʼ]/g, "'");
  if (EMAIL.test(text)) hits.add("email");
  if (PHONE.test(text) || SPACED_DIGITS.test(text)) hits.add("phone");
  if (URL.test(text)) hits.add("url");
  if (HANDLE.test(text)) hits.add("handle");
  if (ADDRESS.test(text) || (ZIP.test(text) && /\b(?:zip|address|live at)\b/i.test(text))) hits.add("address");
  if (looksLikeRealName(text)) hits.add("real_name");
  if (PLATFORM.test(text)) hits.add("platform_mention");
  if (ENCODED.test(text)) hits.add("encoded_contact");

  // employer + location across this message and the sender's recent messages
  const combined = [...recentFromSender.slice(-6), body].join("\n").replace(/[‘’ʼ]/g, "'");
  if (employerMentioned(combined) && locationMentioned(combined) && (employerMentioned(text) || locationMentioned(text))) {
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
  platform_mention: "Mentions of other messaging platforms can lead to sharing contact details, which stay held back until you're both friends.",
  encoded_contact: "This looks like contact details written in a way that avoids filters.",
  employer_location: "Combining where you work with where you live can identify you.",
};

export function hitsAreIdentifying(hits: DetectorHit[]) {
  return hits.some((h) => h !== "platform_mention");
}

// Decision categories that describe identity/contact details only. A decision
// whose categories go beyond these (threats, harassment, scams, doxxing of
// others, …) is never softened with the "become friends" hint.
export const IDENTITY_CATEGORIES = new Set<string>(["identifying_details", "identity", "contact_details", "email", "phone", "url", "handle", "address", "real_name", "platform_mention", "encoded_contact", "employer_location", "self_disclosure"]);
export function categoriesAreIdentityOnly(categories: string[]) {
  return categories.length > 0 && categories.every((c) => IDENTITY_CATEGORIES.has(c));
}
