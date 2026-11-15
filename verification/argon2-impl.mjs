// kdbxweb に組み込む Argon2 実装（2種類を比較する）
import { argon2id as hwArgon2id, argon2d as hwArgon2d } from 'hash-wasm';
import { argon2id as nbArgon2id, argon2d as nbArgon2d } from '@noble/hashes/argon2.js';

// kdbxweb の呼び出し規約: memory は KiB、type 0=Argon2d / 2=Argon2id
export async function hashWasmImpl(password, salt, memory, iterations, length, parallelism, type, version) {
  if (version !== 0x13) throw new Error('unsupported argon2 version ' + version);
  const fn = type === 2 ? hwArgon2id : hwArgon2d;
  const out = await fn({
    password: new Uint8Array(password), salt: new Uint8Array(salt),
    memorySize: memory, iterations, hashLength: length, parallelism, outputType: 'binary',
  });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

export async function nobleImpl(password, salt, memory, iterations, length, parallelism, type, version) {
  if (version !== 0x13) throw new Error('unsupported argon2 version ' + version);
  const fn = type === 2 ? nbArgon2id : nbArgon2d;
  const out = fn(new Uint8Array(password), new Uint8Array(salt), { m: memory, t: iterations, p: parallelism, dkLen: length });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}
