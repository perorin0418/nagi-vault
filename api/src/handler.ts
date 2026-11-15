// Lambda のエントリポイント。S3 を VaultStore の形に包んで渡す。
import { GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { createHandler, PreconditionFailedError, type VaultStore } from './vault.js';

const bucket = process.env['VAULT_BUCKET'];
if (!bucket) throw new Error('VAULT_BUCKET is not set');

const s3 = new S3Client({});

const store: VaultStore = {
  async get(key) {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = await res.Body!.transformToByteArray();
      return { body, etag: res.ETag! };
    } catch (err) {
      // ListBucket 権限を付けているので、存在しない場合は 403 ではなく NoSuchKey になる
      if (err instanceof S3ServiceException && err.name === 'NoSuchKey') return null;
      throw err;
    }
  },
  async put(key, body, cond) {
    try {
      const res = await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: 'application/octet-stream',
          ...('ifMatch' in cond ? { IfMatch: cond.ifMatch } : { IfNoneMatch: cond.ifNoneMatch }),
        }),
      );
      return { etag: res.ETag! };
    } catch (err) {
      // 412: 条件不一致。409: 同じキーへの条件付き書き込みが同時に走った（S3 の仕様）。どちらも取り直しを促す
      const status = err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined;
      if (status === 412 || status === 409) throw new PreconditionFailedError();
      throw err;
    }
  },
};

export const handler = createHandler(store);
