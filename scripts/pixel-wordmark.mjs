import { writeFileSync } from "node:fs";

/* 5x7 pixel font — only the glyphs "MERGE DESK" needs. */
const FONT = {
  M: ["10001", "11011", "10101", "10001", "10001", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  " ": ["000", "000", "000", "000", "000", "000", "000"],
};

const WORD1 = "MERGE";
const WORD2 = "DESK";

const CELL = 14; // square size
const GAP = 2; // space between squares
const PITCH = CELL + GAP;
const PAD = 20;
const ROWS = 7;

const INK = "#D3D3D3"; // app text colour
const ACCENT = "#2383E2"; // app accent
const DIM = "#2A2A2A"; // off-cells, like the loader's dim grid
const BG = "#191919"; // app background

// Lay the two words out on one line with a 3-cell word gap.
const cols = [];
function push(word, colour) {
  for (const ch of word) {
    const glyph = FONT[ch];
    for (let c = 0; c < glyph[0].length; c++) {
      cols.push({ bits: glyph.map((r) => r[c]), colour });
    }
    cols.push(null); // 1-cell letter gap
  }
  cols.pop(); // trailing gap
}
push(WORD1, INK);
for (let i = 0; i < 3; i++) cols.push(null); // word gap
push(WORD2, ACCENT);

const W = cols.length * PITCH - GAP + PAD * 2;
const H = ROWS * PITCH - GAP + PAD * 2;

const rects = [];
cols.forEach((col, x) => {
  for (let y = 0; y < ROWS; y++) {
    const on = col && col.bits[y] === "1";
    // Dim cells keep the loader's grid texture behind the letters.
    const fill = on ? col.colour : DIM;
    const opacity = on ? 1 : 0.55;
    rects.push(
      `<rect x="${PAD + x * PITCH}" y="${PAD + y * PITCH}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}" opacity="${opacity}"/>`,
    );
  }
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Merge Desk">
  <rect width="${W}" height="${H}" rx="14" fill="${BG}"/>
${rects.map((r) => "  " + r).join("\n")}
</svg>
`;

const out = "/Users/tuna/Desktop/merge-desk/docs/wordmark.svg";
writeFileSync(out, svg);
console.log(`wrote ${out}  (${W}x${H}, ${cols.length} cols x ${ROWS} rows)`);
