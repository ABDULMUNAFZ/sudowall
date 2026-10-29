/**
 * Text clean-up used before extraction and matching: invisible characters, Unicode lookalikes
 * and confusable skeletons. Every function keeps a map back to the original UTF-16 offsets
 * where evidence needs them.
 */

/**
 * Characters that render as nothing (or only change direction) and are used to hide or split
 * values: zero-width space/joiners, bidi controls, word joiner and invisible operators, soft
 * hyphen, Mongolian vowel separator, combining grapheme joiner, Arabic letter mark, Hangul
 * fillers, variation selectors, BOM and tag characters.
 */
export const INVISIBLE =
  /(?:[\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFA0]|\u034F|\u17B4|\u17B5|[\uFE00-\uFE0F]|[\u{E0000}-\u{E007F}])/u;
const INVISIBLE_G = new RegExp(INVISIBLE.source, 'gu');

export function hasInvisible(s: string): boolean {
  return INVISIBLE.test(s);
}

export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_G, '');
}

/**
 * Non-ASCII letters that look like ASCII letters (a curated subset of Unicode UTS #39
 * confusables: Cyrillic, Greek, Armenian and Latin lookalikes). Fullwidth and mathematical
 * letters are handled by NFKC first.
 */
const LOOKALIKES: Record<string, string> = {
  // Cyrillic lowercase
  '\u0430': 'a', // cyrillic small letter a
  '\u0432': 'b', // cyrillic small letter ve
  '\u0435': 'e', // cyrillic small letter ie
  '\u0451': 'e', // cyrillic small letter io
  '\u043E': 'o', // cyrillic small letter o
  '\u0440': 'p', // cyrillic small letter er
  '\u0441': 'c', // cyrillic small letter es
  '\u0443': 'y', // cyrillic small letter u
  '\u0445': 'x', // cyrillic small letter ha
  '\u0455': 's', // cyrillic small letter dze
  '\u0456': 'i', // cyrillic small letter byelorussian-ukrainian i
  '\u0457': 'i', // cyrillic small letter yi
  '\u0458': 'j', // cyrillic small letter je
  '\u04BB': 'h', // cyrillic small letter shha
  '\u0501': 'd', // cyrillic small letter komi de
  '\u051B': 'q', // cyrillic small letter qa
  '\u051D': 'w', // cyrillic small letter we
  '\u04CF': 'l', // cyrillic small letter palochka
  '\u043A': 'k', // cyrillic small letter ka
  '\u0442': 't', // cyrillic small letter te
  '\u043C': 'm', // cyrillic small letter em
  '\u043F': 'n', // cyrillic small letter pe
  '\u044C': 'b', // cyrillic small letter soft sign
  '\u0433': 'r', // cyrillic small letter ghe
  // Cyrillic uppercase
  '\u0410': 'A', // cyrillic capital letter a
  '\u0412': 'B', // cyrillic capital letter ve
  '\u0415': 'E', // cyrillic capital letter ie
  '\u041A': 'K', // cyrillic capital letter ka
  '\u041C': 'M', // cyrillic capital letter em
  '\u041D': 'H', // cyrillic capital letter en
  '\u041E': 'O', // cyrillic capital letter o
  '\u0420': 'P', // cyrillic capital letter er
  '\u0421': 'C', // cyrillic capital letter es
  '\u0422': 'T', // cyrillic capital letter te
  '\u0425': 'X', // cyrillic capital letter ha
  '\u0423': 'Y', // cyrillic capital letter u
  '\u0405': 'S', // cyrillic capital letter dze
  '\u0406': 'I', // cyrillic capital letter byelorussian-ukrainian i
  '\u0408': 'J', // cyrillic capital letter je
  '\u0500': 'D', // cyrillic capital letter komi de
  '\u051A': 'Q', // cyrillic capital letter qa
  '\u051C': 'W', // cyrillic capital letter we
  '\u04C0': 'I', // cyrillic letter palochka
  // Greek
  '\u03B1': 'a', // greek small letter alpha
  '\u03B2': 'b', // greek small letter beta
  '\u03B5': 'e', // greek small letter epsilon
  '\u03B9': 'i', // greek small letter iota
  '\u03BA': 'k', // greek small letter kappa
  '\u03BD': 'v', // greek small letter nu
  '\u03BF': 'o', // greek small letter omicron
  '\u03C1': 'p', // greek small letter rho
  '\u03C4': 't', // greek small letter tau
  '\u03C5': 'u', // greek small letter upsilon
  '\u03C7': 'x', // greek small letter chi
  '\u03B3': 'y', // greek small letter gamma
  '\u03C9': 'w', // greek small letter omega
  '\u0391': 'A', // greek capital letter alpha
  '\u0392': 'B', // greek capital letter beta
  '\u0395': 'E', // greek capital letter epsilon
  '\u0396': 'Z', // greek capital letter zeta
  '\u0397': 'H', // greek capital letter eta
  '\u0399': 'I', // greek capital letter iota
  '\u039A': 'K', // greek capital letter kappa
  '\u039C': 'M', // greek capital letter mu
  '\u039D': 'N', // greek capital letter nu
  '\u039F': 'O', // greek capital letter omicron
  '\u03A1': 'P', // greek capital letter rho
  '\u03A4': 'T', // greek capital letter tau
  '\u03A5': 'Y', // greek capital letter upsilon
  '\u03A7': 'X', // greek capital letter chi
  // Armenian
  '\u0585': 'o', // armenian small letter oh
  '\u057D': 'u', // armenian small letter seh
  '\u0581': 'g', // armenian small letter co
  '\u0570': 'h', // armenian small letter ho
  '\u0578': 'n', // armenian small letter vo
  '\u0555': 'O', // armenian capital letter oh
  '\u054D': 'U', // armenian capital letter seh
  // Latin lookalikes
  '\u0131': 'i', // latin small letter dotless i
  '\u0251': 'a', // latin small letter alpha
  '\u0261': 'g', // latin small letter script g
  '\u0269': 'i', // latin small letter iota
  '\u029F': 'L', // latin letter small capital l
  '\u0274': 'N', // latin letter small capital n
  '\uA4F2': 'I', // lisu letter i
  '\u01C0': 'l', // latin letter dental click
  '\u217C': 'l', // small roman numeral fifty
  '\u2113': 'l', // script small l
};

export interface MappedText {
  text: string;
  /** `map[i]` is the original UTF-16 offset of `text[i]`; `map[text.length]` is the end. */
  map: number[];
}

/**
 * Removes invisible characters and maps lookalike letters to ASCII (NFKC per code point, then
 * the table above), keeping offsets into the original text.
 */
export function deconfuse(original: string): MappedText {
  let text = '';
  const map: number[] = [];
  let i = 0;
  for (const cp of original) {
    if (!INVISIBLE.test(cp)) {
      const ascii = cp.charCodeAt(0) < 0x80 ? cp : (LOOKALIKES[cp] ?? cp.normalize('NFKC'));
      const mapped = LOOKALIKES[ascii] ?? ascii;
      for (let k = 0; k < mapped.length; k++) map.push(i);
      text += mapped;
    }
    i += cp.length;
  }
  map.push(i);
  return { text, map };
}

/** True if `s` contains a character that `deconfuse` would turn into a different letter. */
export function hasLookalike(s: string): boolean {
  for (const cp of s) {
    if (cp.charCodeAt(0) >= 0x80 && (LOOKALIKES[cp] !== undefined || cp.normalize('NFKC') !== cp))
      return true;
  }
  return false;
}

/**
 * Confusable skeleton for comparing names (emails, hosts): lookalikes to ASCII, lowercase, then
 * ASCII merges that read alike (`rn`/`m`, `vv`/`w`, `0`/`o`, `1`/`i`/`|`/`l`).
 */
export function skeleton(s: string): string {
  return deconfuse(s)
    .text.toLowerCase()
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/0/g, 'o')
    .replace(/[1i|]/g, 'l');
}
