// kdbx の読み書き。暗号化・復号はすべてこのブラウザの中で行う（HANDOFF 1 章）。
import * as kdbxNs from 'kdbxweb';
import { argon2d, argon2id } from 'hash-wasm';

// kdbxweb は CommonJS なので、バンドラーによって default に入る場合がある
const kdbxweb = ((kdbxNs as unknown as { default?: typeof kdbxNs }).default ?? kdbxNs) as typeof kdbxNs;
export type Kdbx = kdbxNs.Kdbx;
export type KdbxEntry = kdbxNs.KdbxEntry;
export const ProtectedValue = kdbxweb.ProtectedValue;

/**
 * 鍵導出の設定値（docs/verification.md 1 章）。
 * 新しく作る保管庫にだけ使う。既存の保管庫はファイルに書かれた値で開く。
 */
export const KDF_PARAMS = { memoryKiB: 64 * 1024, iterations: 6, parallelism: 2 };

kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type, version) => {
  if (version !== 0x13) throw new Error(`unsupported argon2 version ${version}`);
  const fn = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d;
  const out = await fn({
    password: new Uint8Array(password),
    salt: new Uint8Array(salt),
    memorySize: memory,
    iterations,
    hashLength: length,
    parallelism,
    outputType: 'binary',
  });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
});

const toArrayBuffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function credentials(password: string) {
  return new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password));
}

export function createVault(password: string): Kdbx {
  const db = kdbxweb.Kdbx.create(credentials(password), 'nagi-vault');
  db.setVersion(4);
  db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
  const p = db.header.kdfParameters!;
  p.set('M', kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(KDF_PARAMS.memoryKiB * 1024));
  p.set('I', kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(KDF_PARAMS.iterations));
  p.set('P', kdbxweb.VarDictionary.ValueType.UInt32, KDF_PARAMS.parallelism);
  return db;
}

export class WrongPasswordError extends Error {
  constructor() {
    super('マスターパスワードが違います。');
    this.name = 'WrongPasswordError';
  }
}

export async function openVault(bytes: Uint8Array, password: string): Promise<Kdbx> {
  return loadWith(bytes, credentials(password));
}

/** 同じ資格情報で別の版を開く（412 のときのマージ用） */
export async function openWithSameCredentials(db: Kdbx, bytes: Uint8Array): Promise<Kdbx> {
  return loadWith(bytes, db.credentials);
}

async function loadWith(bytes: Uint8Array, cred: kdbxNs.Credentials): Promise<Kdbx> {
  try {
    return await kdbxweb.Kdbx.load(toArrayBuffer(bytes), cred);
  } catch (err) {
    if (err instanceof kdbxweb.KdbxError && err.code === kdbxweb.Consts.ErrorCodes.InvalidKey) throw new WrongPasswordError();
    throw err;
  }
}

export async function serialize(db: Kdbx): Promise<Uint8Array> {
  return new Uint8Array(await db.save());
}

/** ごみ箱の中か */
function inRecycleBin(db: Kdbx, entry: KdbxEntry): boolean {
  const binId = db.meta.recycleBinUuid?.id;
  if (!binId) return false;
  for (let g = entry.parentGroup; g; g = g.parentGroup) if (g.uuid.id === binId) return true;
  return false;
}

/** 通常の一覧に出す項目（ごみ箱を除く） */
export function listEntries(db: Kdbx): KdbxEntry[] {
  return [...db.getDefaultGroup().allEntries()].filter((e) => !inRecycleBin(db, e));
}

export function groupPath(db: Kdbx, entry: KdbxEntry): string {
  const names: string[] = [];
  for (let g = entry.parentGroup; g && g !== db.getDefaultGroup(); g = g.parentGroup) names.unshift(g.name ?? '');
  return names.join(' / ');
}

export const STANDARD_FIELDS = ['Title', 'UserName', 'Password', 'URL', 'Notes'] as const;

export function fieldText(entry: KdbxEntry, name: string): string {
  const v = entry.fields.get(name);
  if (v === undefined) return '';
  return v instanceof kdbxweb.ProtectedValue ? v.getText() : v;
}

export function isProtected(entry: KdbxEntry, name: string): boolean {
  return entry.fields.get(name) instanceof kdbxweb.ProtectedValue;
}

export type EntryDraft = {
  title: string;
  userName: string;
  password: string;
  url: string;
  notes: string;
  custom: { name: string; value: string; protect: boolean }[];
};

export function draftOf(entry: KdbxEntry): EntryDraft {
  const custom = [...entry.fields.keys()]
    .filter((k) => !(STANDARD_FIELDS as readonly string[]).includes(k))
    .map((name) => ({ name, value: fieldText(entry, name), protect: isProtected(entry, name) }));
  return {
    title: fieldText(entry, 'Title'),
    userName: fieldText(entry, 'UserName'),
    password: fieldText(entry, 'Password'),
    url: fieldText(entry, 'URL'),
    notes: fieldText(entry, 'Notes'),
    custom,
  };
}

function sameDraft(a: EntryDraft, b: EntryDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 下書きを項目に反映する。変更があれば履歴を残して true を返す */
export function applyDraft(entry: KdbxEntry, draft: EntryDraft): boolean {
  if (sameDraft(draftOf(entry), draft)) return false;
  entry.pushHistory();
  const pv = kdbxweb.ProtectedValue.fromString;
  for (const k of [...entry.fields.keys()]) entry.fields.delete(k);
  entry.fields.set('Title', draft.title);
  entry.fields.set('UserName', draft.userName);
  entry.fields.set('Password', pv(draft.password));
  entry.fields.set('URL', draft.url);
  entry.fields.set('Notes', draft.notes);
  for (const c of draft.custom) {
    if (!c.name || (STANDARD_FIELDS as readonly string[]).includes(c.name)) continue;
    entry.fields.set(c.name, c.protect ? pv(c.value) : c.value);
  }
  entry.times.update();
  return true;
}

export function newEntry(db: Kdbx): KdbxEntry {
  const e = db.createEntry(db.getDefaultGroup());
  e.fields.set('Title', '新しい項目');
  e.fields.set('Password', kdbxweb.ProtectedValue.fromString(''));
  return e;
}

/** 削除（ごみ箱へ移動。ごみ箱が無効なら完全削除） */
export function removeEntry(db: Kdbx, entry: KdbxEntry) {
  db.remove(entry);
}

export function attachmentNames(entry: KdbxEntry): string[] {
  return [...entry.binaries.keys()];
}

export function attachmentBytes(entry: KdbxEntry, name: string): Uint8Array | null {
  const b = entry.binaries.get(name);
  if (!b) return null;
  const v: unknown = (b as { value?: unknown }).value ?? b;
  if (v instanceof kdbxweb.ProtectedValue) return v.getBinary();
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v instanceof Uint8Array) return v;
  return null;
}

export async function addAttachment(db: Kdbx, entry: KdbxEntry, name: string, bytes: Uint8Array) {
  entry.pushHistory();
  const bin = await db.createBinary(kdbxweb.ProtectedValue.fromBinary(toArrayBuffer(bytes)));
  entry.binaries.set(uniqueName(entry, name), bin);
  entry.times.update();
}

function uniqueName(entry: KdbxEntry, name: string): string {
  if (!entry.binaries.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 2; ; i++) if (!entry.binaries.has(`${stem} (${i})${ext}`)) return `${stem} (${i})${ext}`;
}

export function removeAttachment(entry: KdbxEntry, name: string) {
  entry.pushHistory();
  entry.binaries.delete(name);
  entry.times.update();
}

/** 添付ファイルの合計（目安。保存後のファイルサイズとは一致しない） */
export function totalAttachmentBytes(db: Kdbx): number {
  let n = 0;
  for (const b of db.binaries.getAll()) {
    const v: unknown = (b as { value?: unknown }).value ?? b;
    if (v instanceof kdbxweb.ProtectedValue) n += v.byteLength;
    else if (v instanceof ArrayBuffer) n += v.byteLength;
  }
  return n;
}

/** 412 のとき：最新版を自分の保管庫に取り込む（docs/verification.md 2 章） */
export async function mergeRemote(db: Kdbx, remoteBytes: Uint8Array) {
  const remote = await openWithSameCredentials(db, remoteBytes);
  db.merge(remote);
}

/** 保存に成功した後に呼ぶ（kdbxweb のマージ用の編集状態を片付ける） */
export function markPushed(db: Kdbx) {
  db.removeLocalEditState();
}

/** パスワード生成（Web Crypto の乱数、偏りのない選び方） */
export function generatePassword(length = 20): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%&*+-=?@_';
  const out: string[] = [];
  const limit = 256 - (256 % chars.length);
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out.push(chars[b % chars.length]!);
    }
  }
  return out.join('');
}
