// 使い方: node measure.mjs <API の URL>
// 要求（保存）と応答（取得）それぞれで通る最大バイト数を二分探索で求める
import { createHash, randomBytes } from 'node:crypto';
const url = process.argv[2].replace(/\/$/, '');
const MiB = 1024 * 1024;

async function tryPost(n) {
  const body = randomBytes(n);
  const res = await fetch(url + '/', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body });
  if (!res.ok) return { ok: false, status: res.status, text: (await res.text()).slice(0, 120) };
  const j = await res.json();
  return { ok: j.bytes === n && j.sha256 === createHash('sha256').update(body).digest('hex') && j.isBase64Encoded, status: res.status, j };
}
async function tryGet(n) {
  const res = await fetch(`${url}/?size=${n}`);
  if (!res.ok) return { ok: false, status: res.status, text: (await res.text()).slice(0, 120) };
  const b = Buffer.from(await res.arrayBuffer());
  return { ok: b.length === n && b.every((x) => x === 0xab), status: res.status, len: b.length };
}
async function search(name, fn) {
  // 1 MiB 刻みで様子を見る
  for (const m of [1, 2, 3, 4, 4.5, 5, 6]) {
    const r = await fn(Math.floor(m * MiB));
    console.log(`${name} ${m} MiB: ${r.ok ? 'OK' : 'NG'} status=${r.status}${r.ok ? '' : ' ' + (r.text ?? JSON.stringify(r.j ?? r.len))}`);
  }
  let lo = 1 * MiB, hi = 6 * MiB; // lo は通る、hi は通らない前提
  while (hi - lo > 1024) { const mid = Math.floor((lo + hi) / 2); (await fn(mid)).ok ? (lo = mid) : (hi = mid); }
  console.log(`${name} 最大（1 KiB 精度）: ${lo} bytes = ${(lo / MiB).toFixed(3)} MiB`);
  return lo;
}
await search('POST(要求)', tryPost);
await search('GET(応答)', tryGet);
