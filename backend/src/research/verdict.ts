import { normalizeMerchant } from '../intake/normalize.js';

/**
 * Purchase verdicts from the owner's profile (sections 2-4, 9-10). Each gate cites the verbatim
 * passage it applies and is active only while that passage is in the current profile, so a profile
 * edit changes the gates. The verdict can discourage a purchase, keeps counter-arguments, and never
 * reads the current consignment as a verdict against a category.
 */

export interface VerdictInput {
  description: string;
  maker?: string;
  category?: string;
  composition?: string;
  clothWeightGsm?: number;
  collarConstruction?: 'sewn' | 'fused' | 'unknown';
  evidenceUrl?: string;
}

export interface OwnedItem {
  garmentId: string;
  name: string;
  category: string;
  color: string | null;
  acquisition: string;
  disposalReason: string | null;
}

export interface Gate {
  key: string;
  status: 'pass' | 'fail' | 'unverified' | 'caution';
  severity: 'reject' | 'discourage' | 'verify' | 'note' | 'positive';
  quote: string;
  detail: string;
}

export interface Verdict {
  verdict: 'worth_considering' | 'verify_first' | 'discourage' | 'reject';
  headline: string;
  gates: Gate[];
  similarOwned: { garmentId: string; name: string }[];
  counterArguments: string[];
  consignmentNote: string | null;
  profileVersion: number | null;
}

interface GateSpec {
  key: string;
  quote: string;
  severity: Gate['severity'];
  applies: (t: string, i: VerdictInput) => boolean;
  detail: string;
}

const SHIRT = /\b(shirt|ocbd|oxford|button[- ]down)\b/i;

const GATES: GateSpec[] = [
  { key: 'visible_branding', quote: 'anything with visible branding', severity: 'reject', applies: (t) => /\b(logo|embroidered crest|branded|brand name|monogram(med)?|big pony|large pony)\b/i.test(t) && !/\b(no logo|logo[- ]free|without (a )?logo|unbranded)\b/i.test(t), detail: 'Visible branding fails the anti-insignia test.' },
  { key: 'polo_cable_vneck', quote: 'polo and cable V-neck jumpers', severity: 'reject', applies: (t) => /\b(cable[- ]knit v[- ]neck|v[- ]neck cable|polo jumper|cricket jumper)\b/i.test(t), detail: 'A filtered-out category (hierarchical-university knitwear).' },
  { key: 'streetwear_punk', quote: 'streetwear and punk styling', severity: 'reject', applies: (t) => /\b(streetwear|hype drop|graphic hoodie|punk)\b/i.test(t), detail: 'Filtered out entirely.' },
  { key: 'watch_jewellery', quote: 'Watches and jewellery are absent by choice', severity: 'reject', applies: (t, i) => /\b(watch|wristwatch|bracelet|necklace|signet ring|cufflinks?)\b/i.test(t) || /^(watch|jewellery|jewelry)$/i.test(i.category ?? ''), detail: 'Watches and jewellery are absent by choice.' },
  { key: 'synthetics', quote: 'synthetics and synthetic-content blends', severity: 'discourage', applies: (t, i) => /\b(polyester|nylon|polyamide|acrylic|elastane|spandex|lycra|viscose|modal|rayon|synthetic)\b/i.test(`${t} ${i.composition ?? ''}`), detail: 'Synthetic content repels by hand-feel.' },
  { key: 'sheen', quote: 'sheen of any kind', severity: 'discourage', applies: (t) => /\b(sheen|shiny|satin|sateen|glossy|lustrous|high[- ]shine)\b/i.test(t), detail: 'Sheen repels.' },
  { key: 'napped_sealed', quote: 'sealed or napped surfaces, moleskin included', severity: 'discourage', applies: (t) => /\b(moleskin|napped|peached|sealed|coated|laminated|bonded)\b/i.test(t), detail: 'Sealed or napped surfaces repel.' },
  { key: 'thin_linen', quote: 'thin linen', severity: 'discourage', applies: (t) => /\blinen\b/i.test(t) && /\b(light(weight)?|thin|airy|sheer|gauze)\b/i.test(t), detail: 'Thin linen repels.' },
  { key: 'merino_sweater', quote: 'merino *sweaters*', severity: 'discourage', applies: (t, i) => /\bmerino\b/i.test(`${t} ${i.composition ?? ''}`) && /\b(sweater|jumper|cardigan|crew ?neck|knit|pullover)\b/i.test(`${t} ${i.category ?? ''}`) && !/\bsocks?\b/i.test(t), detail: 'Merino sweaters read shiny, flat and smothering; merino socks are the exception.' },
  { key: 'dressy_drape', quote: 'dressy drape', severity: 'discourage', applies: (t) => /\b(drapey|fluid drape|dressy drape|silky)\b/i.test(t), detail: 'Dressy drape repels.' },
  { key: 'fused_collar', quote: 'Collars and cuffs must be sewn, never fused', severity: 'discourage', applies: (t, i) => i.collarConstruction === 'fused' || /\bfused (collar|cuffs?)\b/i.test(t), detail: 'A fused collar or cuff fails the construction gate.' },
  { key: 'thin_cloth', quote: 'Cloth must have real weight', severity: 'discourage', applies: (t, i) => /\b(sheer|semi[- ]transparent|see[- ]through|voile|batiste|gauze)\b/i.test(t) || (i.clothWeightGsm !== undefined && SHIRT.test(`${t} ${i.category ?? ''}`) && i.clothWeightGsm < 110), detail: 'Too light: cloth must have real weight.' },
  { key: 'maintenance', quote: 'Cool-wash-only, no-tumble-dry shirts are not worth the maintenance', severity: 'discourage', applies: (t, i) => SHIRT.test(`${t} ${i.category ?? ''}`) && /\b(cool wash only|cold wash only|do not tumble|no tumble|dry clean only)\b/i.test(t), detail: 'Care burden too high for a shirt.' },
  { key: 'costume', quote: 'costumed leisure, workwear styling that has never done any work', severity: 'discourage', applies: (t) => /\b(pre[- ]distressed|faux[- ]vintage|workwear[- ]inspired|heritage[- ]inspired|costume)\b/i.test(t), detail: 'Borrowed authority without use.' },
  { key: 'manufactured_discount', quote: 'retailers inflating recommended prices to manufacture a discount', severity: 'note', applies: (t) => /\b(was|rrp|compare at|originally)\s*[£$€]\s?\d+/i.test(t), detail: 'A “was” price is not evidence of value; judge the object at the price asked.' },
  { key: 'sings', quote: 'Hand-feel is the primary selection driver', severity: 'positive', applies: (t, i) => /\b(oxford|shetland|corduroy|cord|flannel|cashmere|canvas|slub|denim|tweed|donegal)\b/i.test(`${t} ${i.composition ?? ''}`), detail: 'A cloth the profile says sings.' },
];

const TRUSTED = ['Drake\'s', 'Private White V.C.', 'De Bonne Facture', 'Paraboot', 'New Balance', 'Proper Cloth', "Anderson's", 'Cordings'];
const CONSIGNED = /\b(games blazer|jungle jacket|rugby|rugbies)\b/i;

export function purchaseVerdict(input: VerdictInput, profileBody: string, profileVersion: number | null, owned: OwnedItem[], healingActive: boolean): Verdict {
  const text = `${input.description} ${input.category ?? ''}`;
  const gates: Gate[] = [];
  for (const g of GATES) {
    if (!profileBody.includes(g.quote)) continue; // gate retired from the current profile
    if (!g.applies(text, input)) continue;
    gates.push({ key: g.key, status: g.severity === 'positive' ? 'pass' : g.severity === 'note' ? 'caution' : 'fail', severity: g.severity, quote: g.quote, detail: g.detail });
  }
  const maker = input.maker ? normalizeMerchant(input.maker) : null;
  if (maker && TRUSTED.includes(maker) && (profileBody.includes(maker) || profileBody.includes(maker.replace("'", '’')))) {
    gates.push({ key: 'trusted_maker', status: 'pass', severity: 'positive', quote: 'Trusted because their objects remember somewhere real', detail: `${maker} is among the makers trusted because their objects remember somewhere real.` });
  }
  // New shirtmaker: cloth weight and a sewn collar must be verified from evidence.
  const shirtmakerQuote = 'Before any new shirtmaker is recommended, cloth weight and collar construction must be verified rather than taken from a listing.';
  if (SHIRT.test(text) && profileBody.includes(shirtmakerQuote) && !(maker && ['Proper Cloth', "Drake's"].includes(maker))) {
    const verified = input.clothWeightGsm !== undefined && input.collarConstruction === 'sewn' && Boolean(input.evidenceUrl);
    gates.push({
      key: 'new_shirtmaker_verification',
      status: verified ? 'pass' : 'unverified',
      severity: verified ? 'positive' : 'verify',
      quote: shirtmakerQuote,
      detail: verified ? `Verified: ${input.clothWeightGsm} g/m², sewn collar (${input.evidenceUrl}).` : `Missing verified evidence: ${[input.clothWeightGsm === undefined ? 'cloth weight' : null, input.collarConstruction !== 'sewn' ? 'sewn collar' : null, !input.evidenceUrl ? 'source page' : null].filter(Boolean).join(', ')}.`,
    });
  }
  if (healingActive && /\b(welted|goodyear|norwegian|derby|loafer|paraboot|boot)\b/i.test(text)) {
    gates.push({ key: 'healing_restriction', status: 'caution', severity: 'note', quote: 'Sneakers only, until he says his feet have healed.', detail: 'Welted footwear cannot be worn until the healing restriction is lifted by his own statement.' });
  }
  // What it repeats or displaces in the owned wardrobe: same category family, and the same colour when one is named.
  const COLOURS = /\b(navy|blue|olive|stone|cream|brown|rust|green|grey|gray|black|white|red|burgundy|indigo|tan|khaki|ecru)\b/i;
  const colour = input.description.match(COLOURS)?.[1]?.toLowerCase() ?? null;
  const cat = (input.category ?? '').toLowerCase();
  const family = cat === 'jacket' || cat === 'coat' || cat === 'blazer' || cat === 'overshirt' ? ['jacket', 'coat', 'overshirt', 'blazer'] : cat ? [cat] : [];
  const similar = owned
    .filter((o) => o.acquisition !== 'disposed')
    .filter((o) => family.includes(o.category))
    .filter((o) => !colour || `${o.color ?? ''} ${o.name}`.toLowerCase().includes(colour));
  const consignmentQuote = 'The current consignment of oversized pieces is a size correction and not a verdict.';
  const consignmentNote = CONSIGNED.test(text) && profileBody.includes(consignmentQuote)
    ? 'The current consignment was a size correction, not a verdict: he wants this category back in the smaller size. Check the size against the recorded sizes rather than the sold pieces.'
    : null;
  const soldCategory = consignmentNote ? owned.filter((o) => o.disposalReason === 'sold' && CONSIGNED.test(o.name)) : [];
  // Redundancy needs a like-for-like match (same family and named colour); owning many shirts is by design.
  const redundant = colour !== null && (consignmentNote ? similar.length >= 6 : similar.length >= 4);
  if (redundant) gates.push({ key: 'redundant', status: 'fail', severity: 'discourage', quote: 'help you decide that another jacket adds nothing useful', detail: `He already owns ${similar.length} close alternatives (${similar.slice(0, 5).map((s) => s.name).join('; ')}).` });

  const worst = gates.some((g) => g.severity === 'reject' && g.status === 'fail') ? 'reject' : gates.some((g) => g.severity === 'discourage' && g.status === 'fail') ? 'discourage' : gates.some((g) => g.status === 'unverified') ? 'verify_first' : 'worth_considering';
  const positives = gates.filter((g) => g.severity === 'positive');
  const failures = gates.filter((g) => g.status === 'fail');
  const counterArguments: string[] = [];
  if (worst === 'worth_considering') {
    counterArguments.push(similar.length ? `It overlaps with ${similar.length} owned piece(s): ${similar.slice(0, 3).map((s) => s.name).join('; ')}.` : 'Check that it earns its place by use rather than novelty.');
    counterArguments.push('Availability and price must be refreshed on the actual page before buying.');
  } else if (positives.length) {
    counterArguments.push(`In its favour: ${positives.map((p) => p.detail).join(' ')}`);
  }
  if (soldCategory.length) counterArguments.push(`The sold ${soldCategory.map((s) => s.name).join(', ')} left for size, not taste.`);
  const headline =
    worst === 'reject'
      ? `No: ${failures.find((f) => f.severity === 'reject')!.detail}`
      : worst === 'discourage'
        ? `I would not buy it: ${failures.map((f) => f.detail).join(' ')}`
        : worst === 'verify_first'
          ? `Not yet: ${gates.find((g) => g.status === 'unverified')!.detail}`
          : `Worth considering${positives.length ? `: ${positives.map((p) => p.detail).join(' ')}` : '.'}`;
  return { verdict: worst, headline, gates, similarOwned: similar.slice(0, 10).map((s) => ({ garmentId: s.garmentId, name: s.name })), counterArguments, consignmentNote, profileVersion };
}
