// Phase 2 完了条件の確認：デプロイ済みの Lambda を、JWT オーソライザーを通った後と同じ形のイベントで直接呼び出す。
// 実際の S3（保管庫バケット）に対して、利用者の分離と条件付き保存を確かめ、最後にテスト用データを消す。
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
const bucket = outputs.find((o) => o.OutputKey === 'VaultBucketName').OutputValue;
const lambda = new LambdaClient({});

const A = randomUUID(), B = randomUUID();
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'OK' : 'NG'}  ${name} ${extra}`); if (!cond) failed++; };

async function call(sub, method, { body, headers = {} } = {}) {
  const event = {
    version: '2.0', routeKey: `${method} /api/vault`, rawPath: '/api/vault', rawQueryString: '', headers,
    isBase64Encoded: body !== undefined, body: body === undefined ? undefined : Buffer.from(body).toString('base64'),
    requestContext: { http: { method, path: '/api/vault' }, authorizer: { jwt: { claims: { sub }, scopes: [] } } },
  };
  const out = await lambda.send(new InvokeCommand({ FunctionName: fnName, Payload: JSON.stringify(event) }));
  return JSON.parse(Buffer.from(out.Payload).toString());
}

try {
  const c1 = await call(A, 'PUT', { body: 'A-v1', headers: { 'if-none-match': '*' } });
  check('A が新規作成 → 201', c1.statusCode === 201);
  const etag1 = c1.headers.etag;
  check('A が再度新規作成 → 412', (await call(A, 'PUT', { body: 'A-dup', headers: { 'if-none-match': '*' } })).statusCode === 412);
  check('B が取得 → 404（A の保管庫は見えない）', (await call(B, 'GET')).statusCode === 404);
  check('B が A の ETag で保存 → 412（A の保管庫は上書きできない）', (await call(B, 'PUT', { body: 'B-evil', headers: { 'if-match': etag1 } })).statusCode === 412);
  const u1 = await call(A, 'PUT', { body: 'A-v2', headers: { 'if-match': etag1 } });
  check('A が ETag 付きで保存 → 200', u1.statusCode === 200);
  check('A が同じ ETag でもう一度保存 → 412', (await call(A, 'PUT', { body: 'A-v2-stale', headers: { 'if-match': etag1 } })).statusCode === 412);
  const g = await call(A, 'GET');
  check('A が取得 → 最新版の内容と ETag', g.statusCode === 200 && Buffer.from(g.body, 'base64').toString() === 'A-v2' && g.headers.etag === u1.headers.etag);
  check('条件なしの保存 → 428', (await call(A, 'PUT', { body: 'x' })).statusCode === 428);
  const big = await call(A, 'PUT', { body: Buffer.alloc(4 * 1024 * 1024 + 1), headers: { 'if-match': u1.headers.etag } });
  check('4 MiB を超える保存 → 413', big.statusCode === 413);
} finally {
  // テスト用データ（全バージョン）を削除
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
