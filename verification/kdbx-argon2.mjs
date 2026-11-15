// Phase 0: kdbxweb + Argon2id の作成・保存・再読込・添付・速度を検証する
import kdbxwebPkg from 'kdbxweb';
const kdbxweb = kdbxwebPkg.default ?? kdbxwebPkg;
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { hashWasmImpl, nobleImpl } from './argon2-impl.mjs';

const OUT = new URL('./out/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const PASSWORD = 'correct horse battery staple';
const log = (...a) => console.log(...a);

function newDb(memKiB, iterations, parallelism) {
  const cred = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PASSWORD));
  const db = kdbxweb.Kdbx.create(cred, 'nagi-vault-test');
  db.setVersion(4);
  db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
  db.header.kdfParameters.set('M', kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(memKiB * 1024));
  db.header.kdfParameters.set('I', kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(iterations));
  db.header.kdfParameters.set('P', kdbxweb.VarDictionary.ValueType.UInt32, parallelism);
  return { db, cred };
}

async function roundTrip(implName, impl) {
  kdbxweb.CryptoEngine.setArgon2Impl(impl);
  const { db, cred } = newDb(64 * 1024, 2, 2);
  const e = db.createEntry(db.getDefaultGroup());
  e.fields.set('Title', 'example');
  e.fields.set('UserName', 'alice');
  e.fields.set('Password', kdbxweb.ProtectedValue.fromString('s3cr3t-P@ss'));
  e.fields.set('URL', 'https://example.com');
  e.fields.set('Notes', '日本語メモ');
  e.fields.set('CustomField', kdbxweb.ProtectedValue.fromString('custom-protected'));
  const keyBytes = new TextEncoder().encode('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n');
  const bin = await db.createBinary(keyBytes);
  e.binaries.set('id_ed25519', bin);
  const buf = await db.save();
  writeFileSync(new URL(`created-${implName}.kdbx`, OUT), Buffer.from(buf));

  const db2 = await kdbxweb.Kdbx.load(buf, new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PASSWORD)));
  const e2 = db2.getDefaultGroup().entries[0];
  const got = e2.binaries.get('id_ed25519');
  const gotBytes = new Uint8Array(got.value ?? got);
  const ok = db2.header.versionMajor === 4
    && kdbxweb.ByteUtils.bytesToBase64(db2.header.kdfParameters.get('$UUID')) === kdbxweb.Consts.KdfId.Argon2id
    && e2.fields.get('Password').getText() === 's3cr3t-P@ss'
    && e2.fields.get('CustomField').getText() === 'custom-protected'
    && e2.fields.get('Notes') === '日本語メモ'
    && Buffer.compare(Buffer.from(gotBytes), Buffer.from(keyBytes)) === 0;
  log(`[${implName}] KDBX4/Argon2id roundtrip + attachment: ${ok ? 'OK' : 'NG'} (size ${buf.byteLength} B)`);
  // 誤パスワードで失敗すること
  try {
    await kdbxweb.Kdbx.load(buf, new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('wrong')));
    log(`[${implName}] wrong password: NG (opened)`);
  } catch (err) { log(`[${implName}] wrong password rejected: OK (${err.code})`); }
  return ok;
}

async function crossCheck() {
  // 2実装の出力一致（同じ入力で同じ鍵）
  const pw = new TextEncoder().encode('pw').buffer, salt = new Uint8Array(32).fill(7).buffer;
  const a = new Uint8Array(await hashWasmImpl(pw, salt, 1024, 2, 32, 2, 2, 0x13));
  const b = new Uint8Array(await nobleImpl(pw, salt, 1024, 2, 32, 2, 2, 0x13));
  log(`hash-wasm vs noble Argon2id output equal: ${Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0 ? 'OK' : 'NG'}`);
}

async function bench() {
  log('\nArgon2id timing (Node, this machine; p=2):');
  for (const [mem, it] of [[16, 2], [32, 2], [64, 2], [64, 3], [128, 2], [256, 2]]) {
    const pw = new Uint8Array(32).buffer, salt = new Uint8Array(32).buffer;
    let t = performance.now(); await hashWasmImpl(pw, salt, mem * 1024, it, 32, 2, 2, 0x13);
    const hw = performance.now() - t;
    let nb = NaN;
    if (mem <= 64) { t = performance.now(); await nobleImpl(pw, salt, mem * 1024, it, 32, 2, 2, 0x13); nb = performance.now() - t; }
    log(`  m=${mem}MiB t=${it}: hash-wasm ${hw.toFixed(0)} ms, noble ${isNaN(nb) ? '-' : nb.toFixed(0) + ' ms'}`);
  }
}

async function openExternal() {
  // KeePassXC など外部ツールで作成したファイルを開く（存在すれば）
  kdbxweb.CryptoEngine.setArgon2Impl(hashWasmImpl);
  for (const name of ['external-keepassxc.kdbx', 'external-keepassxc-argon2id.kdbx', 'external-pykeepass.kdbx']) {
    const p = new URL(name, OUT);
    if (!existsSync(p)) { log(`${name}: not present (skipped)`); continue; }
    const db = await kdbxweb.Kdbx.load(new Uint8Array(readFileSync(p)).buffer,
      new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PASSWORD)));
    const entries = [];
    for (const e of db.getDefaultGroup().allEntries()) entries.push({
      title: e.fields.get('Title'), pass: e.fields.get('Password')?.getText?.(),
      bins: [...e.binaries.keys()],
    });
    const kdfId = db.header.kdfParameters ? kdbxweb.ByteUtils.bytesToBase64(db.header.kdfParameters.get('$UUID')) : null;
    const kdf = Object.entries(kdbxweb.Consts.KdfId).find(([, v]) => v === kdfId)?.[0] ?? 'AES-KDF';
    log(`${name}: opened OK, KDBX ${db.header.versionMajor}.${db.header.versionMinor}, kdf=${kdf}`, JSON.stringify(entries));
  }
}

await crossCheck();
await roundTrip('hashwasm', hashWasmImpl);
await roundTrip('noble', nobleImpl);
await openExternal();
if (!process.argv.includes('--no-bench')) await bench();
