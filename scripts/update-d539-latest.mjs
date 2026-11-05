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

export function validateRow(row) {
  if (!Array.isArray(row) || row.length !== 9) throw new Error('Invalid draw row');
  const [y,m,d,...rest] = row;
  const date = new Date(Date.UTC(y,m-1,d));
  if (!Number.isInteger(y) || y<2000 || date.getUTCFullYear()!==y || date.getUTCMonth()!==m-1 || date.getUTCDate()!==d) throw new Error('Invalid draw date');
  const nums=rest.slice(0,5);
  if (nums.some(n=>!Number.isInteger(n)||n<1||n>39) || new Set(nums).size!==5 || !/^\d{6}$/.test(normalizePeriod(row[8]))) throw new Error('Invalid draw numbers or period');
  return [y,m,d,...nums.slice().sort((a,b)=>a-b),normalizePeriod(row[8])];
}

export function uniqueSortedRows(rows) {
  const map=new Map();
  for (const raw of rows) {
    const row=validateRow(raw);
    map.set(row[8],row);
  }
  return [...map.values()].sort((a,b)=>Date.UTC(a[0],a[1]-1,a[2])-Date.UTC(b[0],b[1]-1,b[2]));
}

export function parseOfficial(payload) {
  if (payload.rtCode!==0 || !Array.isArray(payload.content?.daily539Res)) throw new Error('Invalid official response');
  return payload.content.daily539Res.map(item=>{
    const date=/^(\d{4})-(\d{2})-(\d{2})/.exec(item.lotteryDate||'');
    if (!date) throw new Error('Invalid official date');
    return validateRow([...date.slice(1).map(Number),...(item.drawNumberSize||[]),normalizePeriod(item.period)]);
  });
}

// Read semantic date/period fields within each draw, independent of CSS nesting.
export function parseHtml(html) {
  const rows=[];
  for (const match of html.matchAll(/<(section|a)\b([^>]*data-game-slug=["']jin-cai-539["'][^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const block=match[2]+' '+match[3];
    const period=block.match(/(?:期別：|第)\s*(\d{6,9})/);
    const date=block.match(/(?:datetime=["']|startDate=)(\d{4})-(\d{2})-(\d{2})/);
    const nums=[...match[3].matchAll(/class=["'][^"']*\bdraw-card__ball\b[^"']*["'][^>]*>\s*(\d{1,2})\s*</g)].map(m=>Number(m[1]));
    if (period&&date&&nums.length===5) rows.push(validateRow([...date.slice(1).map(Number),...nums,normalizePeriod(period[1])]));
  }
  // Older pages expose draw events as JSON-LD; parse JSON instead of property-order regex.
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let root; try { root=JSON.parse(match[1]); } catch { continue; }
    function visit(value) {
      if (!value||typeof value!=='object') return;
      const period=String(value.name||'').match(/第\s*(\d+)\s*期開獎/);
      const date=String(value.startDate||'').match(/^(\d{4})-(\d{2})-(\d{2})/);
      const nums=String(value.description||'').match(/^開獎號碼：\s*([\d,\s]+)$/);
      if(period&&date&&nums) rows.push(validateRow([...date.slice(1).map(Number),...nums[1].split(',').map(Number),normalizePeriod(period[1])]));
      Object.values(value).forEach(visit);
    }
    visit(root);
  }
  if (!rows.length) throw new Error('No valid draws in backup source');
  return uniqueSortedRows(rows);
}

export async function fetchText(url, fetcher=fetch) {
  let last;
  for(let attempt=0;attempt<3;attempt++) {
    try {
      const response=await fetcher(url,{headers:{'user-agent':'Mozilla/5.0 (compatible; 888-auto-update/2.0)'},signal:AbortSignal.timeout(20000)});
      if(!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch(error) { last=error; if(attempt<2) await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1))); }
  }
  throw last;
}

export function expectedDrawDate(now=new Date()) {
  // Allow publication until 23:00 Taipei; Sunday has no regular draw.
  const local=new Date(now.getTime()+8*3600000);
  if(local.getUTCHours()<23) local.setUTCDate(local.getUTCDate()-1);
  while(local.getUTCDay()===0) local.setUTCDate(local.getUTCDate()-1);
  return local.toISOString().slice(0,10);
}

export function dateKey(row) { return `${row[0]}-${String(row[1]).padStart(2,'0')}-${String(row[2]).padStart(2,'0')}`; }

async function loadDraws(oldRows) {
  const local=new Date(Date.now()+8*3600000);
  const currentMonth=local.toISOString().slice(0,7);
  const oldest=oldRows.length ? dateKey(oldRows.at(-1)).slice(0,7) : currentMonth;
  let official=[];
  try {
    // Catch up every missed month, including January/year transitions.
    for(let cursor=new Date(oldest+'-01T00:00:00Z');cursor.toISOString().slice(0,7)<=currentMonth;cursor.setUTCMonth(cursor.getUTCMonth()+1)) {
      const month=cursor.toISOString().slice(0,7);
      const url=`https://api.taiwanlottery.com/TLCAPIWeB/Lottery/Daily539Result?month=${month}&pageNum=1&pageSize=31`;
      official.push(...parseOfficial(JSON.parse(await fetchText(url))));
    }
    if(official.length && dateKey(uniqueSortedRows(official).at(-1))>=expectedDrawDate()) return {rows:official,source:'https://api.taiwanlottery.com/TLCAPIWeB/Lottery/Daily539Result'};
    throw new Error('Official source has not published the expected draw');
  } catch(error) { console.warn('Official source unavailable/stale:',error.message); }
  const backup=parseHtml(await fetchText(source));
  return {rows:uniqueSortedRows([...backup,...official]),source};
}

async function main() {
  const existing=JSON.parse(await fs.readFile(dataPath,'utf8'));
  const oldRows=uniqueSortedRows(existing.rows||[]);
  const fetched=await loadDraws(oldRows);
  const rows=uniqueSortedRows([...oldRows,...fetched.rows]);
  const latest=dateKey(rows.at(-1));
  const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  if(latest>today) throw new Error('Source contains future draw results');
  if(latest<expectedDrawDate()) throw new Error(`Stale draw data: latest ${latest}, expected ${expectedDrawDate()}. Keeping existing files.`);
  // Reject missing periods in the newly fetched range (year resets are allowed).
  for(let i=1;i<rows.length;i++) {
    if(dateKey(rows[i])<=dateKey(oldRows.at(-1))) continue;
    const prev=Number(rows[i-1][8]), next=Number(rows[i][8]);
    if(Math.floor(prev/1000)===Math.floor(next/1000)&&next!==prev+1) throw new Error('Missing draw periods; refusing partial catch-up');
  }

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

  const payload = { source: fetched.source, updatedAt: new Date().toISOString(), latestDrawDate: latest, rows };
  await fs.mkdir(path.dirname(dataPath), { recursive: true });
  await fs.writeFile(dataPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  if (predsChanged) {
    await fs.writeFile(predsPath, `${JSON.stringify(sortedPreds, null, 2)}\n`, 'utf8');
    console.log(`Predictions updated: ${Object.keys(sortedPreds).length} dates in ${predsPath}`);
  }
  console.log(`Updated ${dataPath} with ${rows.length} rows; latest period ${rows.at(-1)?.[8] || 'n/a'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
