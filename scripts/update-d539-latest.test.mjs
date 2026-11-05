import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOfficial, parseHtml, validateRow, uniqueSortedRows, expectedDrawDate, fetchText } from './update-d539-latest.mjs';

test('official data validates and normalizes periods',()=>{
  assert.deepEqual(parseOfficial({rtCode:0,content:{daily539Res:[{period:115000267,lotteryDate:'2026-11-04T00:00:00',drawNumberSize:[39,2,18,8,33]}]}}),[[2026,11,4,2,8,18,33,39,'115267']]);
  assert.throws(()=>parseOfficial({rtCode:1}));
});
test('redesigned source reads hero and history separately',()=>{
  const balls=ns=>ns.map(n=>`<div class="draw-card__ball">${n}</div>`).join('');
  const html=`<section data-game-slug="jin-cai-539"><time datetime="2026-11-04">date</time><p>期別：115000267</p>${balls([2,8,18,33,39])}</section><a data-game-slug="jin-cai-539" href="?startDate=2026-11-03" aria-label="查看今彩539第115000266期">${balls([5,10,30,32,34])}</a>`;
  assert.equal(parseHtml(html).length,2);
  assert.equal(parseHtml(html).at(-1)[8],'115267');
});
test('old JSON-LD does not depend on property order',()=>{
  const html='<script type="application/ld+json">'+JSON.stringify({description:'開獎號碼：02,08,18,33,39',startDate:'2026-11-04',name:'今彩539 第115000267期開獎'})+'</script>';
  assert.equal(parseHtml(html)[0][8],'115267');
});
test('malformed and empty results cannot overwrite good data',()=>{
  assert.throws(()=>validateRow([2026,2,30,1,2,3,4,5,'115267']));
  assert.throws(()=>validateRow([2026,11,4,1,1,3,4,5,'115267']));
  assert.throws(()=>validateRow([2026,11,4,1,2,3,4,40,'115267']));
  assert.throws(()=>parseHtml('<html>Service unavailable</html>'));
  assert.equal(uniqueSortedRows([[2026,11,4,2,8,18,33,39,'115000267'],[2026,11,4,2,8,18,33,39,'115267']]).length,1);
});
test('Taipei cutoff, Sunday, year transition',()=>{
  assert.equal(expectedDrawDate(new Date('2026-11-05T08:00:00Z')),'2026-11-04');
  assert.equal(expectedDrawDate(new Date('2026-11-05T15:01:00Z')),'2026-11-05');
  assert.equal(expectedDrawDate(new Date('2026-11-08T15:01:00Z')),'2026-11-07');
  assert.equal(expectedDrawDate(new Date('2027-01-01T08:00:00Z')),'2026-12-31');
});
test('temporary network errors retry',async()=>{
  let calls=0;
  const result=await fetchText('https://example.invalid',async()=>{if(++calls===1)throw new Error('temporary');return {ok:true,text:async()=>'ok'};});
  assert.equal(result,'ok');assert.equal(calls,2);
});
