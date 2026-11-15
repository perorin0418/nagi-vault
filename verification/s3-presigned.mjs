// 署名付き URL で S3 に直接送る方式の検証（案1）
// 条件（If-Match / If-None-Match）と大きさ（Content-Length）を署名に含め、利用者が外せないことを確かめる。
// 使い方: node s3-presigned.mjs <バージョニング有効のバケット名>
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectVersionsCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const Bucket = process.argv[2];
const Key = `presign-test/${Date.now()}/vault.kdbx`;
const s3 = new S3Client({});
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'OK' : 'NG'}  ${name} ${extra}`); if (!cond) failed++; };
const SIGNED = new Set(['content-length', 'content-type', 'if-match', 'if-none-match']);

async function presignPut(size, cond, expiresIn = 300) {
  const cmd = new PutObjectCommand({ Bucket, Key, ContentLength: size, ContentType: 'application/octet-stream', ...cond });
  return getSignedUrl(s3, cmd, { expiresIn, signableHeaders: SIGNED, unhoistableHeaders: SIGNED });
}
const put = (url, body, headers) => fetch(url, { method: 'PUT', body, headers: { 'content-type': 'application/octet-stream', ...headers } });
const body = (n, c = 1) => new Uint8Array(n).fill(c);

try {
  const u1 = await presignPut(10, { IfNoneMatch: '*' });
  console.log('URL host:', new URL(u1).host, ' signed headers:', new URL(u1).searchParams.get('X-Amz-SignedHeaders'));
  check('条件ヘッダーを付けずに送る → 403', (await put(u1, body(10), {})).status === 403);
  check('署名と違う大きさで送る → 403', (await put(u1, body(11), { 'if-none-match': '*' })).status === 403);
  const r1 = await put(u1, body(10), { 'if-none-match': '*' });
  const etag1 = r1.headers.get('etag');
  check('正しく送る（新規作成）→ 200', r1.status === 200, etag1);
  check('同じ URL で再送（既に存在）→ 412', (await put(u1, body(10), { 'if-none-match': '*' })).status === 412);

  const u2 = await presignPut(20, { IfMatch: etag1 });
  check('If-Match を別の値に差し替えて送る → 403', (await put(u2, body(20), { 'if-match': '"deadbeef"' })).status === 403);
  check('If-None-Match に差し替えて送る → 403', (await put(u2, body(20), { 'if-none-match': '*' })).status === 403);
  const r2 = await put(u2, body(20, 2), { 'if-match': etag1 });
  check('正しい ETag で更新 → 200', r2.status === 200);
  check('同じ ETag で再送 → 412', (await put(u2, body(20, 2), { 'if-match': etag1 })).status === 412);

  const u3 = await presignPut(5, { IfMatch: etag1 }, 1);
  await new Promise((r) => setTimeout(r, 2500));
  check('期限切れの URL → 403', (await put(u3, body(5), { 'if-match': etag1 })).status === 403);

  const g = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 300 });
  const gr = await fetch(g);
  check('署名付き GET → 200、最新版、ETag 付き', gr.status === 200 && (await gr.arrayBuffer()).byteLength === 20 && gr.headers.get('etag') === r2.headers.get('etag'));
} finally {
  const v = await s3.send(new ListObjectVersionsCommand({ Bucket, Prefix: 'presign-test/' }));
  const Objects = [...(v.Versions ?? []), ...(v.DeleteMarkers ?? [])].map((o) => ({ Key: o.Key, VersionId: o.VersionId }));
  if (Objects.length) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects } }));
  console.log(`cleaned up ${Objects.length} versions`);
}
process.exitCode = failed ? 1 : 0;
