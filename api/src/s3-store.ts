// S3 を VaultStore の形に包む
import { GetObjectCommand, PutObjectCommand, S3ServiceException, type S3Client } from '@aws-sdk/client-s3';
import { PreconditionFailedError, type VaultStore } from './vault.js';

type Sender = Pick<S3Client, 'send'>;

const statusOf = (err: unknown) => (err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined);

export function createS3Store(s3: Sender, bucket: string): VaultStore {
  return {
    async get(key) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = await res.Body!.transformToByteArray();
        return { body, etag: res.ETag! };
      } catch (err) {
        // ListBucket 権限を付けているので、存在しない場合は 403 ではなく 404（NoSuchKey）になる
        if (statusOf(err) === 404) return null;
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
        const status = statusOf(err);
        // 412: 条件不一致
        // 409: 同じキーへの条件付き書き込みが同時に走った（S3 の仕様）
        // 404: 存在しないキーに If-Match を付けた（S3 は 412 ではなく NoSuchKey を返す。docs/verification.md 付記）
        if (status === 412 || status === 409 || (status === 404 && 'ifMatch' in cond)) throw new PreconditionFailedError();
        throw err;
      }
    },
  };
}
