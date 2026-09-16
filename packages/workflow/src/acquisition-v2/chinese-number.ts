/**
 * Chinese / roman numeral parsing used by season-episode recognizers and the
 * identifier-word episode-offset step. Covers the same 一二三…百 range
 * MoviePilot gets from cn2an for 第N季/集.
 */
const CN_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const ROMAN: Record<string, number> = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
  VIII: 8,
  IX: 9,
  X: 10,
  XI: 11,
  XII: 12,
  Ⅰ: 1,
  Ⅱ: 2,
  Ⅲ: 3,
  Ⅳ: 4,
  Ⅴ: 5,
  Ⅵ: 6,
  Ⅶ: 7,
  Ⅷ: 8,
  Ⅸ: 9,
  Ⅹ: 10,
  Ⅺ: 11,
  Ⅻ: 12,
};

export function parseChineseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const roman = ROMAN[trimmed] ?? ROMAN[trimmed.toUpperCase()];
  if (roman !== undefined) {
    return roman;
  }
  if (trimmed.includes("百")) {
    const [left, right = ""] = trimmed.split("百");
    const hundreds = left === "" || left === "一" ? 1 : CN_DIGIT[left!];
    if (hundreds === undefined) {
      return null;
    }
    const rest = right.replace(/^零/, "");
    if (rest === "") {
      return hundreds * 100;
    }
    const ones = parseChineseNumber(rest);
    return ones === null ? null : hundreds * 100 + ones;
  }
  if (trimmed === "十") {
    return 10;
  }
  if (trimmed.length === 2 && trimmed.startsWith("十")) {
    const ones = CN_DIGIT[trimmed[1]!];
    return ones === undefined ? null : 10 + ones;
  }
  if (trimmed.length === 2 && trimmed.endsWith("十")) {
    const tens = CN_DIGIT[trimmed[0]!];
    return tens === undefined ? null : tens * 10;
  }
  if (trimmed.length === 3 && trimmed[1] === "十") {
    const tens = CN_DIGIT[trimmed[0]!];
    const ones = CN_DIGIT[trimmed[2]!];
    if (tens === undefined || ones === undefined) {
      return null;
    }
    return tens * 10 + ones;
  }
  return CN_DIGIT[trimmed] ?? null;
}
