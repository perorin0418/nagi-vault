// Lambda のエントリポイント
import { S3Client } from '@aws-sdk/client-s3';
import { createS3Store } from './s3-store.js';
import { createHandler } from './vault.js';

const bucket = process.env['VAULT_BUCKET'];
if (!bucket) throw new Error('VAULT_BUCKET is not set');

export const handler = createHandler(createS3Store(new S3Client({}), bucket));
