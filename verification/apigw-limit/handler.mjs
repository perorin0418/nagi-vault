// Phase 0 検証用 Lambda: バイナリの受け取りサイズと返せるサイズを測る（中身はログに出さない）
import { createHash } from 'node:crypto';
export const handler = async (event) => {
  if (event.requestContext.http.method === 'GET') {
    // GET /?size=N : N バイトのバイナリを返す
    const n = Number(event.queryStringParameters?.size ?? 0);
    const buf = Buffer.alloc(n, 0xab);
    return { statusCode: 200, isBase64Encoded: true, headers: { 'content-type': 'application/octet-stream' }, body: buf.toString('base64') };
  }
  // POST : 受け取ったバイナリの長さと SHA-256 を返す
  const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64') : Buffer.from(event.body ?? '', 'utf8');
  return { statusCode: 200, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isBase64Encoded: event.isBase64Encoded, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }) };
};
