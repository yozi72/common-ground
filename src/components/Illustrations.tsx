// Small inline illustrations. Abstract, no faces or figures that could read
// as a type of person. All use currentColor/tokens so they work in both themes.

export function TwoCups({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 110" className={className} aria-hidden="true" fill="none">
      <ellipse cx="80" cy="96" rx="62" ry="8" fill="var(--bg-2)" />
      <path d="M28 50h44v26a16 16 0 0 1-16 16H44a16 16 0 0 1-16-16V50z" fill="var(--accent-2)" stroke="var(--accent)" strokeWidth="3" />
      <path d="M72 58h8a9 9 0 0 1 0 18h-8" stroke="var(--accent)" strokeWidth="3" />
      <path d="M88 50h44v26a16 16 0 0 1-16 16h-12a16 16 0 0 1-16-16V50z" fill="var(--sage-2)" stroke="var(--sage)" strokeWidth="3" />
      <path d="M88 58h-8a9 9 0 0 0 0 18h8" stroke="var(--sage)" strokeWidth="3" />
      <path d="M44 36c0-6 6-6 6-12M56 36c0-6 6-6 6-12M104 36c0-6 6-6 6-12M116 36c0-6 6-6 6-12" stroke="var(--muted)" strokeWidth="3" strokeLinecap="round" opacity=".6" />
    </svg>
  );
}

export function Bridge({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 110" className={className} aria-hidden="true" fill="none">
      <path d="M10 80c30-50 110-50 140 0" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round" />
      <path d="M10 92h140" stroke="var(--sage)" strokeWidth="5" strokeLinecap="round" />
      <path d="M40 62v30M80 44v48M120 62v30" stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" opacity=".7" />
      <circle cx="30" cy="30" r="9" fill="var(--sun)" />
      <circle cx="130" cy="28" r="5" fill="var(--sun)" opacity=".7" />
    </svg>
  );
}

export function Sprout({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 110" className={className} aria-hidden="true" fill="none">
      <ellipse cx="80" cy="96" rx="48" ry="7" fill="var(--bg-2)" />
      <path d="M80 94V58" stroke="var(--sage)" strokeWidth="5" strokeLinecap="round" />
      <path d="M80 70c-6-18-24-22-36-16 4 16 20 22 36 16z" fill="var(--sage-2)" stroke="var(--sage)" strokeWidth="3" />
      <path d="M80 60c6-18 24-22 36-16-4 16-20 22-36 16z" fill="var(--accent-2)" stroke="var(--accent)" strokeWidth="3" />
      <circle cx="122" cy="26" r="10" fill="var(--sun)" />
    </svg>
  );
}

export function Lantern({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 110" className={className} aria-hidden="true" fill="none">
      <path d="M80 14v10" stroke="var(--muted)" strokeWidth="3" strokeLinecap="round" />
      <rect x="58" y="24" width="44" height="60" rx="14" fill="var(--sun-2)" stroke="var(--sun)" strokeWidth="3" />
      <rect x="70" y="40" width="20" height="28" rx="8" fill="var(--sun)" />
      <path d="M52 92h56" stroke="var(--muted)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="30" cy="40" r="4" fill="var(--sun)" opacity=".6" />
      <circle cx="132" cy="60" r="3" fill="var(--sun)" opacity=".6" />
    </svg>
  );
}

export function Compass({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 110" className={className} aria-hidden="true" fill="none">
      <circle cx="80" cy="55" r="40" fill="var(--card)" stroke="var(--line)" strokeWidth="4" />
      <circle cx="80" cy="55" r="30" stroke="var(--sage-2)" strokeWidth="3" />
      <path d="M80 30l9 25-9 25-9-25z" fill="var(--accent)" />
      <path d="M55 55l25-9 25 9-25 9z" fill="var(--sage)" opacity=".8" />
      <circle cx="80" cy="55" r="5" fill="var(--card)" stroke="var(--fg)" strokeWidth="2" />
    </svg>
  );
}

// Per-question glyphs for the questionnaire: neutral objects, not symbols of a side.
export function QuestionGlyph({ index, className = "" }: { index: number; className?: string }) {
  const glyphs = [
    // 0 gov role: a house and a town hall-ish block, balanced
    <svg key="0" viewBox="0 0 160 110" className={className} aria-hidden="true" fill="none">
      <path d="M26 92V58l26-20 26 20v34z" fill="var(--accent-2)" stroke="var(--accent)" strokeWidth="3" />
      <rect x="92" y="46" width="44" height="46" rx="6" fill="var(--sage-2)" stroke="var(--sage)" strokeWidth="3" />
      <path d="M100 60h28M100 72h28M100 84h28" stroke="var(--sage)" strokeWidth="3" strokeLinecap="round" />
      <ellipse cx="80" cy="98" rx="62" ry="6" fill="var(--bg-2)" />
    </svg>,
    // 1 tradition/change: an old tree and a sapling
    <svg key="1" viewBox="0 0 160 110" className={className} aria-hidden="true" fill="none">
      <path d="M50 92V60" stroke="var(--muted)" strokeWidth="6" strokeLinecap="round" />
      <circle cx="50" cy="46" r="26" fill="var(--sage-2)" stroke="var(--sage)" strokeWidth="3" />
      <path d="M112 92V74" stroke="var(--muted)" strokeWidth="4" strokeLinecap="round" />
      <circle cx="112" cy="66" r="12" fill="var(--accent-2)" stroke="var(--accent)" strokeWidth="3" />
      <ellipse cx="80" cy="98" rx="62" ry="6" fill="var(--bg-2)" />
    </svg>,
    // 2 newcomers: a door with a welcome mat
    <svg key="2" viewBox="0 0 160 110" className={className} aria-hidden="true" fill="none">
      <rect x="54" y="20" width="52" height="70" rx="10" fill="var(--accent-2)" stroke="var(--accent)" strokeWidth="3" />
      <circle cx="94" cy="56" r="4" fill="var(--accent)" />
      <rect x="40" y="88" width="80" height="10" rx="5" fill="var(--sage-2)" stroke="var(--sage)" strokeWidth="3" />
    </svg>,
    // 3 economy: coins and a ladder
    <svg key="3" viewBox="0 0 160 110" className={className} aria-hidden="true" fill="none">
      <ellipse cx="44" cy="80" rx="20" ry="8" fill="var(--sun)" />
      <ellipse cx="44" cy="70" rx="20" ry="8" fill="var(--sun-2)" stroke="var(--sun)" strokeWidth="3" />
      <ellipse cx="44" cy="60" rx="20" ry="8" fill="var(--sun)" />
      <path d="M96 92V24M124 92V24M96 38h28M96 56h28M96 74h28" stroke="var(--sage)" strokeWidth="4" strokeLinecap="round" />
    </svg>,
    // 4 institutions: columns, slightly leaning
    <svg key="4" viewBox="0 0 160 110" className={className} aria-hidden="true" fill="none">
      <path d="M30 40h100l-50-20z" fill="var(--sage-2)" stroke="var(--sage)" strokeWidth="3" />
      <path d="M46 48v38M70 48v38M94 48v38M118 48v38" stroke="var(--muted)" strokeWidth="6" strokeLinecap="round" />
      <rect x="28" y="86" width="104" height="8" rx="4" fill="var(--accent-2)" stroke="var(--accent)" strokeWidth="3" />
    </svg>,
  ];
  return glyphs[index % glyphs.length];
}
