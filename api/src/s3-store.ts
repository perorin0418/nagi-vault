// S3 を VaultStore の形に包む
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3ServiceException, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { VaultStore } from './vault.js';

/**
 * 署名に含めるヘッダー。クエリーに移さず（unhoistable）ヘッダーのまま署名するので、
 * ブラウザがこれらを外したり変えたりすると S3 が 403 を返す（docs/verification.md 5 章で確認）。
 */
const SIGNED_HEADERS = new Set(['content-length', 'content-type', 'if-match', 'if-none-match']);

const statusOf = (err: unknown) => (err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined);

export function createS3Store(s3: S3Client, bucket: string): VaultStore {
  return {
    async head(key) {
      try {
        const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { etag: res.ETag!, size: res.ContentLength ?? 0 };
      } catch (err) {
        // ListBucket 権限を付けているので、存在しない場合は 403 ではなく 404 になる
        if (statusOf(err) === 404) return null;
        throw err;
      }
    },
    presignGet(key, expiresIn) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseCacheControl: 'no-store' }), { expiresIn });
    },
    presignPut(key, size, cond, expiresIn) {
      const cmd = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentLength: size,
        ContentType: 'application/octet-stream',
        ...('ifMatch' in cond ? { IfMatch: cond.ifMatch } : { IfNoneMatch: cond.ifNoneMatch }),
      });
      return getSignedUrl(s3, cmd, { expiresIn, signableHeaders: SIGNED_HEADERS, unhoistableHeaders: SIGNED_HEADERS });
    },
  };
}
