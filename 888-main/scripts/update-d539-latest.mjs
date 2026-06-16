import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dataPath = path.join(repoRoot, 'data', 'd539-latest.json');
const source = 'https://lottery.timetable.tw/jin-cai-539?limit=50&sortOrder=DESC';

function normalizePeriod(period) {
  const digits = String(period ?? '').replace(/\D/g, '');
  if (digits.length === 9 && digits.slice(3, 6) === '000') {
    return `${digits.slice(0, 3)}${digits.slice(6)}`;
  }
  return digits || String(period ?? '');
}

function parseRowsFromItemList(html) {
  const matches = [...html.matchAll(/"name":"[^"]*?第\s*(\d+)\s*期開獎","startDate":"(\d{4})-(\d{2})-(\d{2})","description":"開獎號碼：\s*([\d,\s]+)"/g)];
  return matches.map(([, period, year, month, day, nums]) => {
    const values = nums.split(',').map((part) => Number(part.trim())).filter(Number.isFinite);
    if (values.length !== 5) return null;
    return [Number(year), Number(month), Number(day), ...values, normalizePeriod(period)];
  }).filter(Boolean);
}

function parseRowsFromCards(html) {
  const rows = [];
  const pattern = /draw-card__period">期別：\s*(\d+)\s*•\s*(\d{4})\/(\d{1,2})\/(\d{1,2})<\/p>[\s\S]*?draw-card__numbers">([\s\S]*?)<\/div>\s*<\/div>/g;
  for (const match of html.matchAll(pattern)) {
    const [, period, year, month, day, numbersBlock] = match;
    const values = [...numbersBlock.matchAll(/draw-card__ball">(\d{2})<\/div>/g)].map((item) => Number(item[1]));
    if (values.length !== 5) continue;
    rows.push([Number(year), Number(month), Number(day), ...values, normalizePeriod(period)]);
  }
  return rows;
}

function uniqueSortedRows(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 9) continue;
    map.set(normalizePeriod(row[8]), [...row.slice(0, 8), normalizePeriod(row[8])]);
  }
  return [...map.values()].sort((a, b) => {
    const byDate = new Date(a[0], a[1] - 1, a[2]) - new Date(b[0], b[1] - 1, b[2]);
    if (byDate !== 0) return byDate;
    return String(a[8]).localeCompare(String(b[8]));
  });
}

async function main() {
  const response = await fetch(source, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; 888-auto-update/1.0)'
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch source: HTTP ${response.status}`);
  }

  const html = await response.text();
  const scrapedRows = uniqueSortedRows([
    ...parseRowsFromItemList(html),
    ...parseRowsFromCards(html)
  ]);

  if (!scrapedRows.length) {
    throw new Error('No draw rows parsed from source page');
  }

  let existing = { rows: [] };
  try {
    existing = JSON.parse(await fs.readFile(dataPath, 'utf8'));
  } catch {}

  const rows = uniqueSortedRows([...(existing.rows || []), ...scrapedRows]);
  const payload = {
    source,
    updatedAt: new Date().toISOString(),
    rows
  };

  await fs.mkdir(path.dirname(dataPath), { recursive: true });
  await fs.writeFile(dataPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Updated ${dataPath} with ${rows.length} rows; latest period ${rows.at(-1)?.[8] || 'n/a'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
