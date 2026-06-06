const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const root = process.cwd();
const dataPath = path.join(root, 'data', 'd539-latest.json');
const sourceUrl = 'https://lottery.timetable.tw/jin-cai-539?limit=50&sortOrder=DESC';
const latestCache = { at: 0, payload: null, inflight: null };
const mime = { '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.woff2':'font/woff2' };

function normalizePeriod(period) {
  const digits = String(period ?? '').replace(/\D/g, '');
  if (digits.length === 9 && digits.slice(3, 6) === '000') {
    return `${digits.slice(0, 3)}${digits.slice(6)}`;
  }
  return digits || String(period ?? '');
}

function parseRowsFromCards(html) {
  const rows = [];
  const blocks = html.match(/draw-card__period[\s\S]*?draw-card__numbers[\s\S]*?<\/div>\s*<\/div>/g) || [];
  for (const block of blocks) {
    const meta = block.match(/draw-card__period[^>]*>[\s\S]*?(\d{6,9})\s*[^0-9]+(\d{4})\/(\d{1,2})\/(\d{1,2})<\/p>/);
    if (!meta) continue;
    const [, period, year, month, day] = meta;
    const values = [...block.matchAll(/draw-card__ball">(\d{2})<\/div>/g)].map((item) => Number(item[1]));
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

async function readExistingPayload() {
  try {
    return JSON.parse(await fsp.readFile(dataPath, 'utf8'));
  } catch {
    return { source: sourceUrl, updatedAt: null, rows: [] };
  }
}

async function fetchLatestPayload() {
  const now = Date.now();
  if (latestCache.payload && (now - latestCache.at) < 60000) return latestCache.payload;
  if (latestCache.inflight) return latestCache.inflight;

  latestCache.inflight = (async () => {
    const existing = await readExistingPayload();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(sourceUrl, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; 888-local-preview/1.0)' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const scrapedRows = uniqueSortedRows(parseRowsFromCards(html));
      if (!scrapedRows.length) throw new Error('No draw rows parsed');
      const rows = uniqueSortedRows([...(existing.rows || []), ...scrapedRows]);
      const payload = { source: sourceUrl, updatedAt: new Date().toISOString(), rows };
      await fsp.mkdir(path.dirname(dataPath), { recursive: true });
      await fsp.writeFile(dataPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      latestCache.payload = payload;
      latestCache.at = Date.now();
      return payload;
    } catch (error) {
      const fallback = existing && Array.isArray(existing.rows) ? existing : { source: sourceUrl, updatedAt: null, rows: [] };
      fallback.error = String(error && error.message ? error.message : error);
      latestCache.payload = fallback;
      latestCache.at = Date.now();
      return fallback;
    } finally {
      latestCache.inflight = null;
    }
  })();

  return latestCache.inflight;
}

http.createServer(async (req, res) => {
  const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (reqPath === '/__latest539') {
    try {
      const payload = await fetchLatestPayload();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: String(error && error.message ? error.message : error) }));
    }
    return;
  }

  const safePath = reqPath === '/' ? 'index.html' : reqPath.replace(/^\//, '');
  const filePath = path.join(root, safePath);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {'Content-Type': mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream'});
    res.end(data);
  });
}).listen(8123, '127.0.0.1');

setInterval(() => {}, 1 << 30);
