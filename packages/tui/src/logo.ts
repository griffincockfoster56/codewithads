// Pixel font for the wordmark. Rows: 0 = ascender line, 1-2 = body, 3 = baseline.
// Marks (see component/logo.tsx): _ = shadow cell, ^ = letter top + shadow
// bottom, ~ = shadow top only, , = shadow bottom only.
const FONT: Record<string, string[]> = {
  a: ["    ", "▄▀▀█", "█__█", "▀▀▀▀"],
  c: ["    ", "█▀▀▀", "█___", "▀▀▀▀"],
  d: ["   ▄", "█▀▀█", "█__█", "▀▀▀▀"],
  e: ["    ", "█▀▀█", "█^^^", "▀▀▀▀"],
  h: ["█   ", "█▀▀▄", "█__█", "▀~~▀"],
  i: ["▄", "█", "█", "▀"],
  n: ["    ", "█▀▀▄", "█__█", "▀~~▀"],
  o: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
  p: ["    ", "█▀▀█", "█__█", "█▀▀▀"],
  s: ["    ", "█▀▀▀", "▀▀▀█", "▀▀▀▀"],
  t: [" █  ", "▀█▀▀", "_█__", "~▀▀ "],
  w: ["     ", "█___█", "█_▄_█", "▀▀▀▀▀"],
}

function word(text: string): string[] {
  return [0, 1, 2, 3].map((row) =>
    text
      .split("")
      .map((char) => FONT[char]![row])
      .join(" "),
  )
}

export const logo = {
  left: word("codewith"),
  right: word("ads"),
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"
