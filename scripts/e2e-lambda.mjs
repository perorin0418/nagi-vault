// Phase 2 の完了条件の確認（署名付き URL 方式）：デプロイ済みの Lambda を、JWT オーソライザーを通った後と同じ形の
// イベントで直接呼び出し、返された署名付き URL で実際の S3 に送受信する。利用者の分離と条件付き保存を確かめ、
// 最後にテスト用データを消す。
// 使い方: AWS_PROFILE=... node scripts/e2e-lambda.mjs <スタック名>
import { CloudFormationClient, DescribeStackResourcesCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

const stack = process.argv[2] ?? 'NagiVault-dev';
const cfn = new CloudFormationClient({});
const res = (await cfn.send(new DescribeStackResourcesCommand({ StackName: stack }))).StackResources;
const fnName = res.find((r) => r.ResourceType === 'AWS::Lambda::Function' && r.LogicalResourceId.startsWith('VaultFn')).PhysicalResourceId;
const outputs = (await cfn.send(new DescribeStacksCommand({ StackName: stack }))).Stacks[0].Outputs;
const out = (k) => outputs.find((o) => o.OutputKey === k).OutputValue;
const bucket = out('VaultBucketName');
const origin = out('AppUrl').replace(/\/$/, '');
const lambda = new LambdaClient({});

const A = randomUUID(), B = randomUUID();
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'OK' : 'NG'}  ${name} ${extra}`); if (!cond) failed++; };

async function call(sub, method, path, body) {
  const event = {
    version: '2.0', routeKey: `${method} ${path}`, rawPath: path, rawQueryString: '', headers: {},
    isBase64Encoded: false, body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { http: { method, path }, authorizer: { jwt: { claims: { sub }, scopes: [] } } },
  };
  const r = await lambda.send(new InvokeCommand({ FunctionName: fnName, Payload: JSON.stringify(event) }));
  const p = JSON.parse(Buffer.from(r.Payload).toString());
  return { status: p.statusCode, body: p.body ? JSON.parse(p.body) : {} };
}
/** アップロード用 URL をもらい、画面と同じように S3 に送る */
async function save(sub, bytes, cond) {
  const u = await call(sub, 'POST', '/api/vault/upload-url', { size: bytes.length, ...cond });
  if (u.status !== 200) return { status: u.status, stage: 'api' };
  const put = await fetch(u.body.uploadUrl, { method: 'PUT', headers: { ...u.body.headers, origin }, body: bytes });
  return { status: put.status, etag: put.headers.get('etag'), cors: put.headers.get('access-control-expose-headers'), stage: 's3' };
}
async function load(sub) {
  const g = await call(sub, 'GET', '/api/vault');
  if (g.status !== 200) return { status: g.status };
  const f = await fetch(g.body.downloadUrl, { headers: { origin } });
  return { status: f.status, etag: f.headers.get('etag'), text: await f.text(), meta: g.body };
}

try {
  const c1 = await save(A, Buffer.from('A-v1'), { ifNoneMatch: '*' });
  check('A が新規作成 → 200', c1.status === 200, `ETag を画面から読める: ${c1.cors}`);
  check('A が再度新規作成 → 412', (await save(A, Buffer.from('A-dup'), { ifNoneMatch: '*' })).status === 412);
  check('B が取得 → 404（A の保管庫は見えない）', (await load(B)).status === 404);
  check('B が A の ETag で保存 → 自分の（未作成の）キーなので S3 が 404。A には影響なし', (await save(B, Buffer.from('B-evil'), { ifMatch: c1.etag })).status === 404);
  const u1 = await save(A, Buffer.from('A-v2'), { ifMatch: c1.etag });
  check('A が ETag 付きで保存 → 200', u1.status === 200);
  check('A が同じ ETag でもう一度保存 → 412', (await save(A, Buffer.from('A-v2-stale'), { ifMatch: c1.etag })).status === 412);
  const g = await load(A);
  check('A が取得 → 最新版の内容と ETag', g.status === 200 && g.text === 'A-v2' && g.etag === u1.etag, `size=${g.meta?.size} max=${g.meta?.maxBytes}`);
  check('条件なし → 428', (await call(A, 'POST', '/api/vault/upload-url', { size: 10 })).status === 428);
  check('上限を超える大きさ → 413', (await call(A, 'POST', '/api/vault/upload-url', { size: 64 * 1024 * 1024 + 1, ifMatch: u1.etag })).status === 413);
  check('B の保管庫は作られていない', (await load(B)).status === 404);
} finally {
  const s3 = new S3Client({});
  let n = 0;
  for (const sub of [A, B]) {
    const v = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: `vaults/${sub}/` }));
    const Objects = [...(v.Versions ?? []), ...(v.DeleteMarkers ?? [])].map((o) => ({ Key: o.Key, VersionId: o.VersionId }));
    if (Objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects } }));
    n += Objects.length;
  }
  console.log(`cleaned up ${n} object versions`);
}
process.exitCode = failed ? 1 : 0;
