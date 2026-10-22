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
// Heuristics, not a guarantee (the model and, between friends, the people
// themselves decide). Three strengths of lead-in, validated differently:
//  * STRONG introductions ("my name is X", "my name's X", "my name: X"): X is a
//    name whatever its case ("my name is john", "MY NAME IS JOHN", "My name is
//    Hope" / "Mark" / "Will"), unless X is an obvious non-name from the small
//    explicit stoplist ("my name is secret", "my name is not important").
//    Ordinary-word exclusions do NOT apply here: after "my name is", "Hope" is a name.
//  * MEDIUM ("call me X", "you can call me X"): X must be Capitalized or ALL
//    CAPS and not in the explicit stoplist ("call me Dave" yes; "call me later",
//    "Call me Maybe", "call me crazy" no).
//  * WEAK ("I'm X", "I am X", "it's X", "this is X" standing alone): X must be
//    Capitalized (first letter only) and not an ordinary word, a demonym, a
//    religion, a party, a place, a weekday, a month or another description.
//    ALL CAPS after a weak lead-in is NOT evidence of a name: "I'M FURIOUS",
//    "IT'S OVER", "I AM DYING here" are shouting, and capitalization alone
//    tells nothing in a shouted message. So "I'M MIKE" is not caught by the
//    detector either (documented limit; the model still sees the text).
// Every lead-in in the message is checked, so a name later in a longer
// message is still caught. Apostrophes may be straight or curly.
// Known limits: weak-form names that are ordinary words ("I'm Hope"), ALL CAPS
// or lowercase names after weak or medium lead-ins ("i'm mike", "call me dave"),
// names in other scripts, and names introduced without a lead-in are not
// caught. These are detector results only; the production model's behaviour
// is separate and is probed with `npm run probe`.
const STRONG_NAME = /\b(?:my (?:real |full |last |first |middle )?name(?:'s| is|:))\s+([^\s,.!?;:]+)/gi;
const MEDIUM_NAME = /\b(?:you can call me|call me)\s+([^\s,.!?;:]+)/gi;
const WEAK_NAME = /\b(?:i'm|i am|it's)\s+([^\s,.!?;:]+)/gi;
// "This is X" introduces a person only when X stands alone: "This is Robert," / "This is Robert." / "This is Robert here"
const THIS_IS_NAME = /\bthis is\s+([^\s,.!?;:]+)(?=\s*(?:[,.!]|$|\s+(?:here|speaking|btw)\b))/gi;
const NOT_NAMES_EXPLICIT = new Set(["later","maybe","secret","private","anonymous","anything","whatever","nothing","none","nobody","classified","irrelevant","unimportant","mine","yours","back","soon","tomorrow","tonight","today","now","never","sometime","anytime","again","crazy","old","old-fashioned","young","sir","madam","boss","chief","captain","doctor","dr","mr","mrs","ms","miss","mom","dad","mum","buddy","dude","man","girl","boy","friend","honey","dear","love","babe","baby","kid","kiddo","pal","mate","bro","sis","whenever","if","when","at","on","in","by","after","before","about","directly","please","asap","the","a","an","not","no","yes","what","who","that","this","it","really","just","only","very","so","too","also","still","already","long","short","first","last","same","different","confidential","unknown","hidden","withheld","redacted","omitted","something","someone","hard","easy","common","unusual","weird","funny","boring","beautiful","ugly","up","out","me","you","him","her","them","us","sometimes","usually","mud","legion","nobody's","everything"]);
const CAPITALIZED = /^[A-Z][a-z]+(?:-[A-Z][a-z]+)?$/;     // Mike, Sarah, Mary-Ann
const ALL_CAPS = /^[A-Z]{2,}$/;
const WORDISH = /^[A-Za-z][A-Za-z'-]*$/;
const NOT_NAMES = new Set([
  // ordinary sentence-initial or capitalized words
  "sorry","sure","fine","good","great","okay","ok","not","just","so","really","glad","happy","done","back","still","also","only","very","pretty","kind","curious","interested","thinking","honestly","from","in","at","on","going","trying","here","there","the","a","an","my","your","all","about","what","why","how","it","that","this","new","old","tired","busy","excited","hoping","afraid","worried","mostly","usually","actually","definitely","probably","maybe","always","never","pro","anti","for","against","right","left","wrong","late","early","home","online","off","out","up","down","i","we","they","you","he","she","one","two","three","first","last","alone","lucky","grateful","proud","single","married","divorced","retired","unemployed","disabled","sick","better","worse","ready","open","closed","sad","angry","mad","upset","scared","nervous","hopeful","exhausted","lost","stuck","confused","surprised","shocked","amazed","impressed","thankful","bored","cold","hot","hungry","full","young","older","younger","taller","shorter","big","small","tall","short","deaf","blind","autistic","gay","straight","bi","trans","queer","vegan","vegetarian","sober","religious","spiritual","secular","atheist","agnostic","liberal","conservative","progressive","moderate","libertarian","independent","republican","democrat","democratic","green","socialist","populist","nationalist","patriotic","catholic","protestant","christian","orthodox","evangelical","baptist","methodist","lutheran","presbyterian","pentecostal","mormon","lds","jewish","muslim","hindu","buddhist","sikh","roman","native","american","african","asian","european","latino","latina","latinx","hispanic","black","white","indigenous","mexican","canadian","british","english","irish","scottish","welsh","italian","german","french","spanish","polish","russian","ukrainian","chinese","japanese","korean","vietnamese","filipino","thai","indian","pakistani","arab","persian","iranian","turkish","greek","portuguese","brazilian","cuban","dominican","puerto","nigerian","ethiopian","somali","jamaican","haitian","texan","californian","southern","northern","midwestern","western","eastern","appalachian","rural","urban","suburban","gen","boomer","millennial","generation","army","navy","marine","veteran","military","union","blue","red","purple","team","type","class","middle","working","upper","lower","hope","joy","faith","grace","chance","will","art","may","june","april","august","summer","autumn","winter","spring","destiny","liberty","justice","honor","honour","hunter","reed","bill","mark","rich","frank","guy","sunny","rose","ivy","ruby","pearl","daisy","holly","jasmine","dawn","eve","texas","california","florida","york","ohio","georgia","alaska","hawaii","america","europe","asia","africa","canada","mexico","england","france","germany","italy","spain","china","japan","india","israel","russia","brazil","australia","ireland","scotland","london","paris","chicago","boston","seattle","portland","denver","austin","dallas","houston","miami","atlanta","detroit","phoenix","vegas","philly","brooklyn","jersey","heaven","hell","earth",
  // emotions, states and shouted words that follow "I'm" / "it's"
  "furious","livid","over","dying","done","finished","serious","kidding","joking","fed","sick","thrilled","devastated","heartbroken","speechless","leaving","staying","listening","here","there","fine","well","alright","alive","free","broke","rich","poor","hurt","hungry","cool","chill","wild","crazy","nuts","insane","outraged","disgusted","terrified","petrified","delighted","ecstatic","embarrassed","ashamed","sorry","wrong","right","late","early","good","bad","great","awesome","terrible","horrible","true","false","possible","impossible","unbelievable","ridiculous","official","official","complicated","simple","nothing","everything","something","someone","nobody","everyone","important","urgent","time","midnight","noon","christmas","easter","thanksgiving","halloween","monday","tuesday","wednesday","thursday","friday","saturday","sunday","january","february","march","july","september","october","november","december","weekend","morning","evening","tonight","today","tomorrow","yesterday",
]);
function nameAfterStrongLeadIn(word: string) {
  // any case; only the explicit stoplist excludes ("my name is secret")
  return WORDISH.test(word) && word.length >= 2 && !NOT_NAMES_EXPLICIT.has(word.toLowerCase());
}
function nameAfterMediumLeadIn(word: string) {
  return (CAPITALIZED.test(word) || ALL_CAPS.test(word)) && !NOT_NAMES_EXPLICIT.has(word.toLowerCase());
}
function nameAfterWeakLeadIn(word: string) {
  // Capitalized only; ALL CAPS is shouting, not a name; ordinary words and descriptions are not names
  const w = word.toLowerCase();
  return CAPITALIZED.test(word) && !NOT_NAMES.has(w) && !NOT_NAMES_EXPLICIT.has(w);
}
function looksLikeRealName(body: string) {
  const text = body.replace(/[\u2018\u2019\u02BC]/g, "'");
  for (const m of text.matchAll(STRONG_NAME)) if (nameAfterStrongLeadIn(m[1] ?? "")) return true;
  for (const m of text.matchAll(MEDIUM_NAME)) if (nameAfterMediumLeadIn(m[1] ?? "")) return true;
  for (const m of [...text.matchAll(WEAK_NAME), ...text.matchAll(THIS_IS_NAME)]) if (nameAfterWeakLeadIn(m[1] ?? "")) return true;
  return false;
}

// --- employer + location ----------------------------------------------------
// Lead-ins are case-insensitive (sentence-initial "From Boston." counts); the
// employer and the place must look like names (Capitalized or ALL CAPS, not a
// generic word: "I work at home", "in general"). "City, ST" counts in any case.
const EMPLOYER = /\b(?:i work (?:at|for)|my employer is|i'm employed (?:at|by)|i teach at|i'm an? [a-z]+ (?:at|for|with))\s+([^\s,.!?;:]+)/gi;
const NOT_EMPLOYERS = new Set(["home","a","an","the","my","night","nights","remote","remotely","myself","two","three","several","various","different","many","another","one","this","that","school","work","church","it","there","here","now","least","most","all","some","any","no","our","their","his","her","your","random","small","big","large","local","every","each"]);
const LOCATION = /\b(?:in|near|from|outside)\s+([^\s,.!?;:]+)(?:\s+([^\s,.!?;:]+))?/gi;
const CITY_STATE = /\b(?:in|near|from)\s+[a-z]+(?:\s[a-z]+)?,\s*[A-Z]{2}\b/gi;
const NOT_PLACES = new Set(["i","my","the","a","an","this","that","it","there","here","january","february","march","april","may","june","july","august","september","october","november","december","monday","tuesday","wednesday","thursday","friday","saturday","sunday","god","jesus","christ","college","school","church","town","case","fact","general","short","summary","person","theory","practice","particular","time","terms","order","addition","spite","front","love","touch","charge","part","full","return","america","europe","asia","africa"]);
const NAMEISH = /^(?:[A-Z][a-z]+|[A-Z]{2,})[\w&.'-]*$/;
function employerMentioned(text: string) {
  for (const m of text.matchAll(EMPLOYER)) { const w = m[1] ?? ""; if (NAMEISH.test(w) && !NOT_EMPLOYERS.has(w.toLowerCase())) return true; }
  return false;
}
function locationMentioned(text: string) {
  if (CITY_STATE.test(text)) { CITY_STATE.lastIndex = 0; return true; }
  CITY_STATE.lastIndex = 0;
  for (const m of text.matchAll(LOCATION)) {
    const w = m[1] ?? "";
    if (NAMEISH.test(w) && !NOT_PLACES.has(w.toLowerCase())) return true;
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
