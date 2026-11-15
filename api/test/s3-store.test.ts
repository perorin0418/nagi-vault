import { describe, expect, it } from 'vitest';
import { S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { createS3Store } from '../src/s3-store.js';

// 署名はローカルで計算されるので、ダミーの認証情報で URL の中身を確かめられる
const offlineClient = () =>
  new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' } });

const s3Error = (name: string, status: number) =>
  new S3ServiceException({ name, $fault: 'client', $metadata: { httpStatusCode: status }, message: name });

function withSend(send: (cmd: unknown) => unknown) {
  const c = offlineClient();
  (c as unknown as { send: unknown }).send = async (cmd: unknown) => send(cmd);
  return c;
}

describe('createS3Store.head', () => {
  it('ETag とサイズを返す', async () => {
    const store = createS3Store(withSend(() => ({ ETag: '"e"', ContentLength: 42 })), 'b');
    expect(await store.head('k')).toEqual({ etag: '"e"', size: 42 });
  });
  it('存在しなければ null', async () => {
    const store = createS3Store(withSend(() => { throw s3Error('NotFound', 404); }), 'b');
    expect(await store.head('k')).toBeNull();
  });
  it('権限エラーなどはそのまま投げる', async () => {
    const store = createS3Store(withSend(() => { throw s3Error('AccessDenied', 403); }), 'b');
    await expect(store.head('k')).rejects.toThrow('AccessDenied');
  });
});

describe('createS3Store.presignPut', () => {
  const signedHeaders = (url: string) => new URL(url).searchParams.get('X-Amz-SignedHeaders')!.split(';');

  it('If-None-Match・大きさ・種類を、クエリーではなくヘッダーとして署名に含める', async () => {
    const url = await createS3Store(offlineClient(), 'my-bucket').presignPut('vaults/u/vault.kdbx', 123, { ifNoneMatch: '*' }, 300);
    const u = new URL(url);
    expect(u.host).toBe('my-bucket.s3.us-east-1.amazonaws.com');
    expect(u.pathname).toBe('/vaults/u/vault.kdbx');
    expect(signedHeaders(url)).toEqual(expect.arrayContaining(['content-length', 'content-type', 'host', 'if-none-match']));
    expect(signedHeaders(url)).not.toContain('if-match');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
    // 条件がクエリーに移されていない（クエリーだと S3 は条件として扱わない）
    expect([...u.searchParams.keys()].some((k) => /if-?(none-)?match/i.test(k))).toBe(false);
  });

  it('If-Match を署名に含める', async () => {
    const url = await createS3Store(offlineClient(), 'b').presignPut('k', 1, { ifMatch: '"x"' }, 60);
    expect(signedHeaders(url)).toEqual(expect.arrayContaining(['content-length', 'if-match']));
    expect(signedHeaders(url)).not.toContain('if-none-match');
  });
});

describe('createS3Store.presignGet', () => {
  it('指定したキーの GET 用 URL を返す', async () => {
    const url = new URL(await createS3Store(offlineClient(), 'my-bucket').presignGet('vaults/u/vault.kdbx', 300));
    expect(url.pathname).toBe('/vaults/u/vault.kdbx');
    expect(url.searchParams.get('response-cache-control')).toBe('no-store');
  });
});
