// Phase 0: S3 条件付き書き込み（IfMatch / IfNoneMatch:"*"）をバージョニング有効バケットで検証する
// 使い方: node s3-conditional.mjs <バージョニング有効の検証用バケット名>
// ※ 実在の AWS リソースに書き込むので、実行前に利用者の確認を取ること。
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, ListObjectVersionsCommand, GetBucketVersioningCommand } from '@aws-sdk/client-s3';

const Bucket = process.argv[2];
if (!Bucket) { console.error('usage: node s3-conditional.mjs <bucket>'); process.exit(2); }
const Key = `phase0-test/${Date.now()}/vault.kdbx`;
const s3 = new S3Client({});
const check = (name, cond, extra = '') => { console.log(`${cond ? 'OK' : 'NG'}  ${name} ${extra}`); if (!cond) process.exitCode = 1; };
const status = async (p) => { try { const r = await p; return { code: 200, etag: r.ETag }; } catch (e) { return { code: e.$metadata?.httpStatusCode, name: e.name }; } };
const put = (Body, cond) => s3.send(new PutObjectCommand({ Bucket, Key, Body, ...cond }));

const v = await s3.send(new GetBucketVersioningCommand({ Bucket }));
check('バケットのバージョニングが有効', v.Status === 'Enabled', `(${v.Status})`);

const r1 = await status(put(Buffer.from('v1'), { IfNoneMatch: '*' }));
check('新規作成 IfNoneMatch:* → 成功', r1.code === 200, JSON.stringify(r1));
const r2 = await status(put(Buffer.from('v1-dup'), { IfNoneMatch: '*' }));
check('既存に IfNoneMatch:* → 412', r2.code === 412, JSON.stringify(r2));
const r3 = await status(put(Buffer.from('v2'), { IfMatch: r1.etag }));
check('正しい ETag で IfMatch → 成功', r3.code === 200, JSON.stringify(r3));
const r4 = await status(put(Buffer.from('v2-stale'), { IfMatch: r1.etag }));
check('古い ETag で IfMatch → 412', r4.code === 412, JSON.stringify(r4));
const g = await s3.send(new GetObjectCommand({ Bucket, Key }));
check('GetObject の ETag が最新版と一致', g.ETag === r3.etag, `${g.ETag}`);
check('内容は v2 のまま', (await g.Body.transformToString()) === 'v2');

// 後片付け（全バージョン削除）
const vers = await s3.send(new ListObjectVersionsCommand({ Bucket, Prefix: Key }));
const Objects = [...(vers.Versions ?? []), ...(vers.DeleteMarkers ?? [])].map((o) => ({ Key: o.Key, VersionId: o.VersionId }));
if (Objects.length) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects } }));
console.log(`cleaned up ${Objects.length} versions`);
