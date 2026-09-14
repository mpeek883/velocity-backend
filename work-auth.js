// United States work authorization screening used by candidate matching,
// board sourcing and imports. Text is classified into:
//   authorized      an explicit statement of US work authorization
//   not_authorized  needs sponsorship / not authorized / outside the US
//   unknown         nothing stated
// A location is separately judged US / non-US so board posts from abroad
// are excluded even when they say nothing about authorization.

const AUTHORIZED_RE = /\b(us|u\.s\.|usa|united states|american)\s+citizen(ship)?\b|\bcitizen of the (us|united states)\b|\bgreen ?card\b|\bpermanent resident\b|\b(lawful|legal) permanent\b|\bauthori[sz]ed to work in the (us|u\.s\.|usa|united states)\b|\bus work authori[sz]ation\b|\bwork authori[sz]ation:?\s*(yes|us|usa|authori[sz]ed|citizen)\b|\b(ead|employment authori[sz]ation document)\b|\b(h-?1b|h1-?b|tn|l-?1|o-?1|opt|stem opt|cpt)\b(?![^.\n]*\b(sponsor|require|need))|\bno sponsorship (needed|required)\b|\bwithout sponsorship\b|\bdo(es)? not (require|need) sponsorship\b|\bgc holder\b|\busc\b/i;
const NOT_AUTHORIZED_RE = /\b(require|requires|need|needs|needing|will need|looking for|seeking)\s+(visa\s+|h-?1b\s+|work\s+)?sponsorship\b|\bsponsorship\s+(required|needed)\b|\bnot (currently )?authori[sz]ed to work\b|\bno (us |u\.s\. )?work (authori[sz]ation|permit)\b|\bwork authori[sz]ation:?\s*(no|none|not yet|needs? sponsorship)\b|\brequires? (a )?visa\b|\bvisa required\b|\bwilling to relocate:?\s*(yes|to the us)[^.\n]*\b(sponsor|visa)\b/i;

const US_STATES = ['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming', 'district of columbia', 'puerto rico'];
const US_CITIES = ['new york', 'nyc', 'los angeles', 'chicago', 'houston', 'phoenix', 'philadelphia', 'san antonio', 'san diego', 'dallas', 'austin', 'san jose', 'san francisco', 'sf bay', 'bay area', 'seattle', 'denver', 'boston', 'atlanta', 'miami', 'washington', 'dc', 'dmv', 'baltimore', 'charlotte', 'raleigh', 'nashville', 'detroit', 'minneapolis', 'portland', 'las vegas', 'orlando', 'tampa', 'pittsburgh', 'columbus', 'cincinnati', 'kansas city', 'st. louis', 'salt lake', 'sacramento', 'indianapolis', 'milwaukee', 'richmond', 'norfolk', 'frederick', 'round rock'];
const STATE_ABBR_RE = /\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;
const NON_US_RE = /\b(india|bengaluru|bangalore|hyderabad|pune|chennai|mumbai|delhi|noida|gurgaon|kolkata|pakistan|lahore|karachi|bangladesh|dhaka|nepal|sri lanka|philippines|manila|vietnam|hanoi|indonesia|jakarta|malaysia|singapore|thailand|bangkok|china|beijing|shanghai|shenzhen|hong kong|taiwan|japan|tokyo|korea|seoul|australia|sydney|melbourne|new zealand|auckland|uk|u\.k\.|united kingdom|england|london|manchester|scotland|ireland|dublin|germany|berlin|munich|france|paris|spain|madrid|barcelona|portugal|lisbon|italy|rome|milan|netherlands|amsterdam|belgium|brussels|switzerland|zurich|austria|vienna|poland|warsaw|krakow|czech|prague|hungary|budapest|romania|bucharest|ukraine|kyiv|russia|moscow|turkey|istanbul|israel|tel aviv|egypt|cairo|nigeria|lagos|kenya|nairobi|south africa|cape town|johannesburg|ghana|morocco|uae|dubai|saudi|riyadh|qatar|doha|brazil|sao paulo|argentina|buenos aires|colombia|bogota|mexico|mexico city|guadalajara|chile|santiago|peru|lima|canada|toronto|vancouver|montreal|calgary|ottawa|europe|eu\b|emea|latam|apac)\b/i;

const NO_SPONSOR_NEEDED_RE = /\bno (visa |h-?1b )?sponsorship (needed|required|necessary)\b|\bwithout (visa )?sponsorship\b|\bdo(es)? not (require|need) (visa |any )?sponsorship\b|\bsponsorship (is )?not (required|needed)\b/i;
function classifyWorkAuth(text) {
  const t = String(text || '');
  if (!t.trim()) return { status: 'unknown', reason: 'nothing stated' };
  const fine = t.match(NO_SPONSOR_NEEDED_RE);
  if (fine) return { status: 'authorized', reason: fine[0].trim() };
  const no = t.match(NOT_AUTHORIZED_RE);
  if (no) return { status: 'not_authorized', reason: no[0].trim() };
  const yes = t.match(AUTHORIZED_RE);
  if (yes) return { status: 'authorized', reason: yes[0].trim() };
  return { status: 'unknown', reason: 'nothing stated' };
}

/** 'us' | 'non_us' | 'unknown' from a location string or free text. */
function locationRegion(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return 'unknown';
  if (/\b(usa|u\.s\.a\.|u\.s\.|united states|us-based|us based|remote \(us\)|remote, us|us remote|us only|within the us|in the us)\b/.test(t)) return 'us';
  if (US_STATES.some((s) => t.includes(s)) || US_CITIES.some((c) => new RegExp(`\\b${c.replace(/[.]/g, '\\.')}\\b`).test(t)) || STATE_ABBR_RE.test(String(text || ''))) {
    return NON_US_RE.test(t) && !/\b(usa|united states)\b/.test(t) ? 'unknown' : 'us';
  }
  if (NON_US_RE.test(t)) return 'non_us';
  return 'unknown';
}

/**
 * Screen a person for US work eligibility from whatever text we have.
 * Returns { eligible: true|false|null, status, region, reason }.
 *   eligible true  -> authorized, or in the US with nothing contrary stated
 *   eligible false -> needs sponsorship / not authorized / located outside the US
 *   eligible null  -> unknown (no location, nothing stated)
 */
function screenUS({ workAuth = '', location = '', text = '' } = {}) {
  const auth = classifyWorkAuth(`${workAuth}\n${text}`);
  const region = locationRegion(location) === 'unknown' ? locationRegion(text) : locationRegion(location);
  if (auth.status === 'not_authorized') return { eligible: false, status: auth.status, region, reason: auth.reason };
  if (auth.status === 'authorized') return { eligible: true, status: auth.status, region, reason: auth.reason };
  if (region === 'non_us') return { eligible: false, status: 'unknown', region, reason: 'located outside the United States' };
  if (region === 'us') return { eligible: true, status: 'unknown', region, reason: 'US-based; authorization not stated, confirm before submitting' };
  return { eligible: null, status: 'unknown', region, reason: 'no location or authorization stated' };
}

module.exports = { classifyWorkAuth, locationRegion, screenUS };
