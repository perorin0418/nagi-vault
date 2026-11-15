import { describe, expect, it } from 'vitest';
import { GetObjectCommand, PutObjectCommand, S3ServiceException } from '@aws-sdk/client-s3';
import { createS3Store } from '../src/s3-store.js';
import { PreconditionFailedError } from '../src/vault.js';

const s3Error = (name: string, status: number) =>
  new S3ServiceException({ name, $fault: 'client', $metadata: { httpStatusCode: status }, message: name });

function fakeS3(handler: (cmd: unknown) => unknown) {
  const sent: unknown[] = [];
  return { sent, client: { send: async (cmd: unknown) => { sent.push(cmd); return handler(cmd); } } as never };
}

describe('createS3Store', () => {
  it('GET: 存在しなければ null', async () => {
    const { client } = fakeS3(() => { throw s3Error('NoSuchKey', 404); });
    expect(await createS3Store(client, 'b').get('k')).toBeNull();
  });

  it('GET: 権限エラーなどはそのまま投げる', async () => {
    const { client } = fakeS3(() => { throw s3Error('AccessDenied', 403); });
    await expect(createS3Store(client, 'b').get('k')).rejects.toThrow('AccessDenied');
  });

  it('PUT: 条件をそのまま S3 に渡す', async () => {
    const { client, sent } = fakeS3(() => ({ ETag: '"e"' }));
    const store = createS3Store(client, 'b');
    await store.put('k', new Uint8Array([1]), { ifNoneMatch: '*' });
    await store.put('k', new Uint8Array([1]), { ifMatch: '"x"' });
    const inputs = sent.map((c) => (c as PutObjectCommand).input);
    expect(inputs[0]).toMatchObject({ Bucket: 'b', Key: 'k', IfNoneMatch: '*' });
    expect(inputs[0]).not.toHaveProperty('IfMatch');
    expect(inputs[1]).toMatchObject({ Bucket: 'b', Key: 'k', IfMatch: '"x"' });
    expect(inputs[1]).not.toHaveProperty('IfNoneMatch');
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect(sent).not.toContainEqual(expect.any(GetObjectCommand));
  });

  it.each([
    ['412 PreconditionFailed', 412, { ifMatch: '"x"' }],
    ['409 ConditionalRequestConflict', 409, { ifMatch: '"x"' }],
    ['404 NoSuchKey（存在しないキーに If-Match）', 404, { ifMatch: '"x"' }],
    ['412 PreconditionFailed（If-None-Match）', 412, { ifNoneMatch: '*' }],
  ] as const)('PUT: %s は PreconditionFailedError にする', async (_, status, cond) => {
    const { client } = fakeS3(() => { throw s3Error('E', status); });
    await expect(createS3Store(client, 'b').put('k', new Uint8Array([1]), cond)).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it('PUT: それ以外のエラーはそのまま投げる', async () => {
    const { client } = fakeS3(() => { throw s3Error('AccessDenied', 403); });
    await expect(createS3Store(client, 'b').put('k', new Uint8Array([1]), { ifMatch: '"x"' })).rejects.toThrow('AccessDenied');
  });
});
