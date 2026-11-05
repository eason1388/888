/* Show the age of published results even when an upstream job fails. */
(function () {
  let latest = null;
  let failed = false;
  function expectedDate() {
    const d = new Date(Date.now() + 8 * 3600000);
    if (d.getUTCHours() < 23) d.setUTCDate(d.getUTCDate() - 1);
    while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  function render() {
    const panel = document.getElementById('__v8');
    if (!latest || !panel) return;
    let el = document.getElementById('__data_health');
    if (!el) {
      el = document.createElement('div');
      el.id = '__data_health';
      el.setAttribute('role', 'status');
      panel.prepend(el);
    }
    const stale = latest < expectedDate();
    el.style.cssText = 'width:100%;max-width:860px;margin:0 auto;padding:10px 16px;font:12px/1.6 sans-serif;box-sizing:border-box;color:' + (stale || failed ? '#ffd479;background:#392d18;' : '#9bcab8;background:#13251f;');
    el.textContent = '開獎資料截至 ' + latest.replace(/-/g, '/') + (stale ? ' · 更新延遲，請勿視為最新一期；系統將自動重試。' : failed ? ' · 暫時無法連線，顯示上次資料。' : ' · 已同步最新已公布資料');
  }
  async function check() {
    try {
      const response = await fetch('./data/d539-latest.json?v=' + Date.now(), {cache:'no-store',signal:AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (!Array.isArray(data.rows) || !data.rows.length) throw new Error('Empty results');
      latest = data.rows.map(r => r[0]+'-'+String(r[1]).padStart(2,'0')+'-'+String(r[2]).padStart(2,'0')).sort().at(-1);
      failed = false;
    } catch (error) { failed = true; }
    render();
  }
  check();
  // Document is replaced during startup; restore the status after unpacking.
  setInterval(render, 5000);
  setInterval(check, 60000);
})();
