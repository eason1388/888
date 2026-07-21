import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dataPath = path.join(repoRoot, 'data', 'd539-latest.json');
const predsPath = path.join(repoRoot, 'data', 'd539-preds.json');
const source = 'https://lottery.timetable.tw/jin-cai-539?limit=50&sortOrder=DESC';

/* ─ 預測邏輯（熱號策略）─ 只用 priorRows（該期之前的資料），確保不含未來資訊 */
function predictTop2(priorRows) {
  const window = priorRows.slice(-30);
  if (!window.length) return [1, 2];
  const freq = {};
  for (let i = 1; i <= 39; i++) freq[i] = 0;
  for (const row of window) for (const n of row.slice(3, 8)) freq[n] = (freq[n] || 0) + 1;
  if (window.length >= 10) {
    for (const row of window.slice(-10)) for (const n of row.slice(3, 8)) freq[n] = (freq[n] || 0) + 1;
  }
  return Array.from({ length: 39 }, (_, i) => i + 1)
    .sort((a, b) => (freq[b] || 0) - (freq[a] || 0) || a - b)
    .slice(0, 2);
}

/* 計算下一個開獎日（跳過週日） */
function nextDrawDate(year, month, day) {
  const d = new Date(year, month - 1, day);
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0) d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function normalizePeriod(period) {
  const digits = String(period ?? '').replace(/\D/g, '');
  if (digits.length === 9 && digits.slice(3, 6) === '000') return `${digits.slice(0, 3)}${digits.slice(6)}`;
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

function parseRowsFromGeneric(html) {
  const rows = [];
  const periodPattern = /期別：\s*(\d+)\s*[•·]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/g;
  const matches = [...html.matchAll(periodPattern)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const [, period, year, month, day] = match;
    const blockEnd = matches[i + 1]?.index ?? Math.min(match.index + 2000, html.length);
    const block = html.slice(match.index, blockEnd);
    const numSection = block.match(/開獎號碼([\s\S]{0,400})/);
    if (!numSection) continue;
    const nums = [];
    for (const m of numSection[1].matchAll(/\b(\d{1,2})\b/g)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 39 && !nums.includes(n)) nums.push(n);
      if (nums.length === 5) break;
    }
    if (nums.length !== 5) continue;
    rows.push([Number(year), Number(month), Number(day), ...nums, normalizePeriod(period)]);
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
  const response = await fetch(source, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; 888-auto-update/1.0)' } });
  if (!response.ok) throw new Error(`Failed to fetch source: HTTP ${response.status}`);

  const html = await response.text();
  const scrapedRows = uniqueSortedRows([...parseRowsFromItemList(html), ...parseRowsFromCards(html), ...parseRowsFromGeneric(html)]);
  if (!scrapedRows.length) throw new Error('No draw rows parsed from source page');

  let existing = { rows: [] };
  try { existing = JSON.parse(await fs.readFile(dataPath, 'utf8')); } catch {}
  const oldRows = existing.rows || [];
  const rows = uniqueSortedRows([...oldRows, ...scrapedRows]);

  /* ── 預測凍結 ─────────────────────────────────────────────────────────
     原則：
     1. 每個開獎日的「預測」永遠用「該日之前的所有資料」計算，不含當日。
     2. 一旦寫入 preds，永不覆蓋（歷史預測不可篡改）。
     3. 每次執行時掃描全部開獎日，自動補齊缺漏（防止 preds 與 latest 脫鉤）。
     ────────────────────────────────────────────────────────────────── */
  let preds = {};
  try { preds = JSON.parse(await fs.readFile(predsPath, 'utf8')); } catch {}

  let predsChanged = false;

  // ── 補漏掃描：確保每一個已知開獎日都有預測 ──
  for (let i = 0; i < rows.length; i++) {
    const [year, month, day] = rows[i];
    const dateKey = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    if (!preds[dateKey]) {
      const priorRows = rows.slice(0, i); // strictly before this draw
      preds[dateKey] = predictTop2(priorRows);
      predsChanged = true;
      console.log(`  補漏 ${dateKey}: [${preds[dateKey]}]（由 ${priorRows.length} 期計算）`);
    }
  }

  // ── 為下一個開獎日預存預測 ──
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    const nextKey = nextDrawDate(last[0], last[1], last[2]);
    if (!preds[nextKey]) {
      preds[nextKey] = predictTop2(rows); // 用所有已知資料預測下一期
      predsChanged = true;
      console.log(`  預存下期 ${nextKey}: [${preds[nextKey]}]`);
    }
  }

  // Sort preds by date
  const sortedPreds = Object.fromEntries(Object.entries(preds).sort(([a],[b])=>a.localeCompare(b)));

  const payload = { source, updatedAt: new Date().toISOString(), rows };
  await fs.mkdir(path.dirname(dataPath), { recursive: true });
  await fs.writeFile(dataPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  if (predsChanged) {
    await fs.writeFile(predsPath, `${JSON.stringify(sortedPreds, null, 2)}\n`, 'utf8');
    console.log(`Predictions updated: ${Object.keys(sortedPreds).length} dates in ${predsPath}`);
  }
  console.log(`Updated ${dataPath} with ${rows.length} rows; latest period ${rows.at(-1)?.[8] || 'n/a'}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
