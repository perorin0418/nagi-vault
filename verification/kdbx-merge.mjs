// Phase 0: kdbxweb の merge() で、同時編集された2つの版を統合できるか検証する
import kdbxwebPkg from 'kdbxweb';
import { hashWasmImpl } from './argon2-impl.mjs';
const kdbxweb = kdbxwebPkg.default ?? kdbxwebPkg;
kdbxweb.CryptoEngine.setArgon2Impl(hashWasmImpl);

const pv = (s) => kdbxweb.ProtectedValue.fromString(s);
const cred = () => new kdbxweb.Credentials(pv('pw'));
const load = (buf) => kdbxweb.Kdbx.load(buf.slice(0), cred());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const titles = (db) => [...db.getDefaultGroup().allEntries()].filter((e) => e.parentGroup?.uuid?.id !== db.meta.recycleBinUuid?.id).map((e) => e.fields.get('Title')).sort();
const check = (name, cond) => { console.log(`${cond ? 'OK' : 'NG'}  ${name}`); if (!cond) process.exitCode = 1; };

// 版0（S3 上の基準版）
const db0 = kdbxweb.Kdbx.create(cred(), 'merge-test');
db0.setVersion(4); db0.setKdf(kdbxweb.Consts.KdfId.Argon2id);
db0.header.kdfParameters.set('M', kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(1024 * 1024));
for (const t of ['shared', 'to-delete-by-B', 'edit-conflict']) db0.createEntry(db0.getDefaultGroup()).fields.set('Title', t);
const base = await db0.save();

// 端末A・端末B が同じ版0を開く
const a = await load(base);
const b = await load(base);
await sleep(1100); // 更新時刻は秒精度なので差を付ける

// B: 項目追加・削除・競合項目の編集 → 先に保存（S3 は版1へ）
b.createEntry(b.getDefaultGroup()).fields.set('Title', 'added-by-B');
b.remove([...b.getDefaultGroup().allEntries()].find((e) => e.fields.get('Title') === 'to-delete-by-B'));
const bConf = [...b.getDefaultGroup().allEntries()].find((e) => e.fields.get('Title') === 'edit-conflict');
bConf.pushHistory(); bConf.fields.set('Password', pv('from-B')); bConf.times.update();
const v1 = await b.save();
await sleep(1100);

// A: 項目追加・競合項目の編集（Bより後）→ 保存しようとして 412 になった想定
a.createEntry(a.getDefaultGroup()).fields.set('Title', 'added-by-A');
const aConf = [...a.getDefaultGroup().allEntries()].find((e) => e.fields.get('Title') === 'edit-conflict');
aConf.pushHistory(); aConf.fields.set('Password', pv('from-A')); aConf.times.update();

// A: 最新版(v1)を取り直してマージ
const remote = await load(v1);
a.merge(remote);
const merged = await load(await a.save());
console.log('merged titles (ごみ箱除く):', titles(merged));
check('A と B の追加が両方残る', titles(merged).includes('added-by-A') && titles(merged).includes('added-by-B'));
const delEntry = [...merged.getDefaultGroup().allEntries()].find((e) => e.fields.get('Title') === 'to-delete-by-B');
const recycleBin = merged.getGroup(merged.meta.recycleBinUuid);
check('B の削除がごみ箱への移動として反映される', !!recycleBin && delEntry?.parentGroup === recycleBin);
const mc = [...merged.getDefaultGroup().allEntries()].find((e) => e.fields.get('Title') === 'edit-conflict');
check('同一項目の競合は更新時刻が新しい側(A)が勝つ', mc.fields.get('Password').getText() === 'from-A');
check('負けた側(B)の値は履歴に残る', mc.history.some((h) => h.fields.get('Password')?.getText?.() === 'from-B'));

// ごみ箱を空にした場合（完全削除 = deletedObjects の墓標）もマージで消えるか
const c0 = await load(base); c0.meta.recycleBinEnabled = false; const base2 = await c0.save();
const p = await load(base2), q = await load(base2);
q.remove([...q.getDefaultGroup().allEntries()].find((e) => e.fields.get('Title') === 'shared'));
const v2 = await q.save();
p.createEntry(p.getDefaultGroup()).fields.set('Title', 'added-by-P');
p.merge(await load(v2));
const m2 = await load(await p.save());
check('完全削除(墓標)もマージで反映される', !titles(m2).includes('shared') && titles(m2).includes('added-by-P'));
