// nagi-vault の画面
//
// 守ること（HANDOFF 3.4）:
// - マスターパスワードと復号した中身は、このページの外（サーバー、ログ、分析ツール）に送らない。
//   サーバーに送るのは serialize() で暗号化した kdbx だけ。console にも出さない。
// - トークンはメモリにだけ置く（auth.ts）。
import './style.css';
import { ApiError, AuthRequiredError, ConflictError, fetchVault, MAX_VAULT_BYTES, setDevMode, storeVault } from './api';
import { handleRedirect, initAuth, login, logout, userEmail } from './auth';
import { loadConfig, type AppConfig } from './config';
import { CsvFormatError, parseLoginCsv } from './csv-import';
import { downloadBytes, formatBytes, h } from './dom';
import * as K from './kdbx';

/** 上限の 90% で警告する（上限はサーバーの応答で決まる） */
const warnBytes = () => MAX_VAULT_BYTES * 0.9;
const IDLE_LOCK_MS = 10 * 60 * 1000;
const CLIPBOARD_CLEAR_MS = 30 * 1000;
const MAX_SAVE_ATTEMPTS = 3;

const root = document.getElementById('app')!;

type State = {
  config: AppConfig | null;
  dev: boolean;
  db: K.Kdbx | null;
  etag: string | null;
  /** 最後に暗号化したときのファイルサイズ */
  size: number;
  /** 最後に暗号化した後に追加した添付ファイルの合計（サイズの目安用） */
  addedSinceSerialize: number;
  dirty: boolean;
  selected: K.KdbxEntry | null;
  draft: K.EntryDraft | null;
  search: string;
  busy: boolean;
  message: { kind: 'info' | 'error' | 'warn'; text: string } | null;
};

const state: State = {
  config: null,
  dev: false,
  db: null,
  etag: null,
  size: 0,
  addedSinceSerialize: 0,
  dirty: false,
  selected: null,
  draft: null,
  search: '',
  busy: false,
  message: null,
};

/** ロゴ（web/public/logo.svg）。文字の「nagi-vault」と並べるので、画像自体の代替テキストは空にする */
const logo = (size: number) => h('img', { src: '/logo.svg', alt: '', width: size, height: size, class: 'logo', draggable: 'false' });

/** カード上部の見出し（ロゴ付き） */
const cardTitle = (text: string) => h('div', { class: 'card-title' }, logo(40), h('h1', {}, text));

function show(...nodes: Node[]) {
  root.replaceChildren(...nodes);
}

function errorText(err: unknown): string {
  if (err instanceof K.WrongPasswordError || err instanceof ApiError) return err.message;
  // 想定外のエラーは種類だけを表示する（中身を含めない）
  return `エラーが発生しました（${err instanceof Error ? err.name : 'unknown'}）`;
}

// ---------------------------------------------------------------- 起動

async function main() {
  show(h('p', { class: 'center muted' }, '読み込み中…'));
  try {
    state.config = await loadConfig();
    state.dev = import.meta.env.DEV && state.config.dev === true;
    setDevMode(state.dev);
    initAuth(state.config);
    if (!state.dev && !(await handleRedirect())) return showLogin();
    await loadRemote();
  } catch (err) {
    showFatal(errorText(err));
  }
}

function showFatal(text: string) {
  show(
    h('section', { class: 'card narrow' },
      cardTitle('nagi-vault'),
      h('p', { class: 'msg error' }, text),
      h('button', { onclick: () => location.assign('/') }, '最初からやり直す'),
    ),
  );
}

function showLogin() {
  show(
    h('section', { class: 'card narrow' },
      cardTitle('nagi-vault'),
      h('p', {}, 'パスワード保管庫です。続けるにはログインしてください。'),
      h('p', { class: 'muted small' }, 'ログインのパスワードと、保管庫を開くマスターパスワードは別のものです。'),
      h('button', { class: 'primary', onclick: () => void login() }, 'ログイン'),
    ),
  );
}

async function loadRemote() {
  show(h('p', { class: 'center muted' }, '保管庫を確認しています…'));
  try {
    const remote = await fetchVault();
    if (remote) showUnlock(remote);
    else showCreate();
  } catch (err) {
    if (err instanceof AuthRequiredError) return showLogin();
    showFatal(errorText(err));
  }
}

// ---------------------------------------------------------------- 新規作成

const forgetWarning = () =>
  h('div', { class: 'msg warn' },
    h('strong', {}, 'マスターパスワードを忘れると、保管庫は二度と開けません。'),
    ' サーバー側では中身を読めないため、管理者にも復旧できません。マスターパスワードは紙などに控え、保管庫ファイルも定期的にダウンロードして別に保管してください。',
  );

function showCreate() {
  const pw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 12, required: true, id: 'pw' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, id: 'pw2' });
  const ack = h('input', { type: 'checkbox', id: 'ack', required: true });
  const msg = h('p', { class: 'msg error', hidden: true });
  const submit = h('button', { class: 'primary', type: 'submit' }, '保管庫を作る');

  const form = h('form', { class: 'card narrow' },
    cardTitle('保管庫を作る'),
    h('p', {}, 'まだ保管庫がありません。マスターパスワードを決めてください。'),
    forgetWarning(),
    h('label', { for: 'pw' }, 'マスターパスワード（12 文字以上）'), pw,
    h('label', { for: 'pw2' }, 'もう一度入力'), pw2,
    h('label', { class: 'check' }, ack, '忘れると復旧できないことを理解しました'),
    msg, submit,
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.hidden = true;
    if (pw.value.length < 12) return fail('12 文字以上にしてください。');
    if (pw.value !== pw2.value) return fail('2 回の入力が一致しません。');
    submit.disabled = true;
    submit.textContent = '暗号化しています…';
    try {
      const db = K.createVault(pw.value);
      const bytes = await K.serialize(db);
      const etag = await storeVault(bytes, null);
      pw.value = pw2.value = '';
      enterVault(db, etag, bytes.byteLength);
      setMessage('info', '保管庫を作りました。');
    } catch (err) {
      if (err instanceof ConflictError) return fail('別の端末で先に保管庫が作られました。ページを再読み込みして開いてください。');
      if (err instanceof AuthRequiredError) return showLogin();
      fail(errorText(err));
    } finally {
      submit.disabled = false;
      submit.textContent = '保管庫を作る';
    }
  });
  function fail(text: string) {
    msg.textContent = text;
    msg.hidden = false;
  }
  show(form);
  pw.focus();
}

// ---------------------------------------------------------------- 開く

function showUnlock(remote: { bytes: Uint8Array; etag: string }) {
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, id: 'pw' });
  const msg = h('p', { class: 'msg error', hidden: true });
  const submit = h('button', { class: 'primary', type: 'submit' }, '開く');
  const form = h('form', { class: 'card narrow' },
    cardTitle('保管庫を開く'),
    h('p', { class: 'muted small' }, `保管庫のサイズ: ${formatBytes(remote.bytes.byteLength)}`),
    h('label', { for: 'pw' }, 'マスターパスワード'), pw,
    msg, submit,
    h('p', { class: 'muted small' }, 'マスターパスワードを忘れた場合、保管庫は復旧できません。'),
    state.dev ? null : h('button', { type: 'button', class: 'link', onclick: () => logout() }, 'ログアウト'),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.hidden = true;
    submit.disabled = true;
    submit.textContent = '復号しています…';
    const started = performance.now();
    try {
      const db = await K.openVault(remote.bytes, pw.value);
      pw.value = '';
      enterVault(db, remote.etag, remote.bytes.byteLength);
      setMessage('info', `保管庫を開きました（${((performance.now() - started) / 1000).toFixed(1)} 秒）。`);
    } catch (err) {
      msg.textContent = errorText(err);
      msg.hidden = false;
      pw.select();
    } finally {
      submit.disabled = false;
      submit.textContent = '開く';
    }
  });
  show(form);
  pw.focus();
}

function enterVault(db: K.Kdbx, etag: string, size: number) {
  Object.assign(state, { db, etag, size, addedSinceSerialize: 0, dirty: false, selected: null, draft: null, search: '', message: null });
  renderMain();
}

function lock() {
  Object.assign(state, { db: null, etag: null, dirty: false, selected: null, draft: null, message: null });
  void loadRemote();
}

// ---------------------------------------------------------------- 保管庫の画面

function setMessage(kind: 'info' | 'error' | 'warn', text: string) {
  state.message = { kind, text };
  renderMain();
}

function markDirty() {
  state.dirty = true;
}

/** 編集中の下書きを項目に反映する */
function commitDraft() {
  if (state.selected && state.draft && K.applyDraft(state.selected, state.draft)) markDirty();
}

function estimatedSize() {
  return state.size + state.addedSinceSerialize;
}

/** 直前に描いた項目（同じ項目を描き直すときだけ、編集欄のスクロール位置を保つ） */
let renderedEntry: K.KdbxEntry | null = null;

function renderMain() {
  const db = state.db;
  if (!db) return;
  // 画面を作り直すとスクロール位置が先頭に戻るので、一覧と編集欄の位置を覚えておいて戻す
  const listScroll = root.querySelector('.list')?.scrollTop ?? 0;
  const editorScroll = root.querySelector('.editor')?.scrollTop ?? 0;
  const sameEntry = renderedEntry === state.selected;

  show(h('div', { class: 'layout' }, renderHeader(), state.message ? h('p', { class: `msg ${state.message.kind}` }, state.message.text) : null, h('div', { class: 'body' }, renderList(db), renderEditor(db))));

  renderedEntry = state.selected;
  root.querySelector('.list')!.scrollTop = listScroll;
  if (sameEntry) root.querySelector('.editor')!.scrollTop = editorScroll;
  // 選んだ項目（追加した項目を含む）が見えていなければ、見える位置までだけ動かす
  root.querySelector('.entry.selected')?.scrollIntoView({ block: 'nearest' });
}

function renderHeader() {
  const size = estimatedSize();
  const ratio = Math.min(1, size / MAX_VAULT_BYTES);
  const meter = h('meter', { min: 0, max: 1, low: 0.9, high: 0.95, optimum: 0, value: ratio });
  return h('header', { class: 'top' },
    h('div', { class: 'brand' }, logo(32), h('div', { class: 'brand-text' }, h('strong', {}, 'nagi-vault'), h('span', { class: 'muted small' }, state.dev ? '開発モード（模擬 API）' : (userEmail() ?? '')))),
    h('div', { class: 'size', title: '保存のたびに保管庫全体を送るため、上限があります' },
      meter, h('span', { class: `small ${size >= warnBytes() ? 'warn-text' : 'muted'}` }, `${formatBytes(size)} / ${formatBytes(MAX_VAULT_BYTES)}`)),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', disabled: state.busy || !isDirty(), onclick: () => void save() }, isDirty() ? '保存' : '保存済み'),
      h('button', { disabled: state.busy, onclick: () => void download() }, 'ダウンロード'),
      h('button', { disabled: state.busy, title: 'Chrome・Brave・Edge・Firefox などが書き出したパスワードの CSV を取り込みます', onclick: pickCsv }, 'CSV を取り込む'),
      confirmButton('ロック', '変更を破棄してロック', () => isDirty(), lock),
      state.dev ? null : confirmButton('ログアウト', '変更を破棄してログアウト', () => isDirty(), () => logout()),
    ),
  );
}

function isDirty() {
  if (state.dirty) return true;
  if (state.selected && state.draft) return JSON.stringify(K.draftOf(state.selected)) !== JSON.stringify(state.draft);
  return false;
}

/** 確認が必要なときだけ 2 回押しにするボタン（ブラウザのダイアログは使わない） */
function confirmButton(label: string, confirmLabel: string, needsConfirm: () => boolean, action: () => void, cls = '') {
  const b = h('button', { class: cls, disabled: state.busy }, label);
  let armed = false;
  let timer: number | undefined;
  const disarm = () => {
    clearTimeout(timer);
    armed = false;
    b.textContent = label;
    b.classList.remove('danger');
  };
  b.addEventListener('click', () => {
    if (!needsConfirm() || armed) {
      // 実行したら確認状態を解除する（続けて押したときも、もう一度確認する）
      disarm();
      return action();
    }
    armed = true;
    b.textContent = confirmLabel;
    b.classList.add('danger');
    timer = window.setTimeout(disarm, 4000);
  });
  return b;
}

function renderList(db: K.Kdbx) {
  const q = state.search.trim().toLowerCase();
  const entries = K.listEntries(db)
    .filter((e) => !q || [K.fieldText(e, 'Title'), K.fieldText(e, 'UserName'), K.fieldText(e, 'URL')].some((s) => s.toLowerCase().includes(q)))
    .sort((a, b) => K.fieldText(a, 'Title').localeCompare(K.fieldText(b, 'Title'), 'ja'));
  const search = h('input', { type: 'search', placeholder: '検索', value: state.search, 'aria-label': '検索' });
  search.addEventListener('input', () => {
    state.search = search.value;
    const list = renderList(db);
    root.querySelector('.list')!.replaceWith(list);
    (list.querySelector('input[type=search]') as HTMLInputElement).focus();
  });
  return h('nav', { class: 'list' },
    h('div', { class: 'list-tools' }, search, h('button', { onclick: addEntry, disabled: state.busy }, '＋ 新しい項目')),
    entries.length === 0 ? h('p', { class: 'muted small pad' }, q ? '一致する項目がありません。' : '項目はまだありません。') : null,
    h('ul', {}, entries.map((e) =>
      h('li', {},
        h('button', { class: `entry ${e === state.selected ? 'selected' : ''}`, onclick: () => selectEntry(e) },
          h('span', { class: 'title' }, K.fieldText(e, 'Title') || '（無題）'),
          h('span', { class: 'muted small' }, [K.groupPath(db, e), K.fieldText(e, 'UserName')].filter(Boolean).join(' · ')),
        ),
      ),
    )),
  );
}

function selectEntry(e: K.KdbxEntry) {
  commitDraft();
  state.selected = e;
  state.draft = K.draftOf(e);
  renderMain();
}

function addEntry() {
  commitDraft();
  const e = K.newEntry(state.db!);
  markDirty();
  state.selected = e;
  state.draft = K.draftOf(e);
  renderMain();
  (root.querySelector('#f-title') as HTMLInputElement | null)?.select();
}

function renderEditor(db: K.Kdbx) {
  const entry = state.selected;
  const d = state.draft;
  if (!entry || !d) return h('section', { class: 'editor empty' }, h('p', { class: 'muted' }, '左の一覧から項目を選ぶか、新しい項目を追加してください。'));

  const bind = <T extends HTMLInputElement | HTMLTextAreaElement>(input: T, set: (v: string) => void): T => {
    input.addEventListener('input', () => {
      set(input.value);
      refreshSaveButton();
    });
    return input;
  };
  const text = (id: string, label: string, value: string, set: (v: string) => void, extra: Node[] = []) =>
    h('div', { class: 'field' }, h('label', { for: id }, label), h('div', { class: 'row' }, bind(h('input', { id, value, autocomplete: 'off', spellcheck: 'false' }), set), ...extra));

  const pwInput = bind(h('input', { id: 'f-password', type: 'password', value: d.password, autocomplete: 'new-password', spellcheck: 'false' }), (v) => (d.password = v));
  const toggle = h('button', { type: 'button', onclick: () => { pwInput.type = pwInput.type === 'password' ? 'text' : 'password'; toggle.textContent = pwInput.type === 'password' ? '表示' : '隠す'; } }, '表示');
  // 生成：すでにパスワードが入っているときは 2 回押しで確認し、生成後は「元に戻す」で直前の値に戻せるようにする
  let previousPassword: string | null = null;
  const setPassword = (v: string) => {
    d.password = pwInput.value = v;
    refreshSaveButton();
  };
  const undo = h('button', { type: 'button', hidden: true }, '元に戻す');
  undo.addEventListener('click', () => {
    if (previousPassword !== null) setPassword(previousPassword);
    previousPassword = null;
    undo.hidden = true;
  });
  // 手で書き換えたら、元に戻す対象はなくなる
  pwInput.addEventListener('input', () => {
    previousPassword = null;
    undo.hidden = true;
  });
  const gen = confirmButton('生成', '上書きして生成', () => d.password !== '', () => {
    // 続けて生成しても、元に戻す先は最初のパスワードのままにする
    if (previousPassword === null && d.password !== '') previousPassword = d.password;
    setPassword(K.generatePassword());
    pwInput.type = 'text';
    toggle.textContent = '隠す';
    undo.hidden = previousPassword === null;
  });
  gen.type = 'button';

  const custom = h('div', { class: 'custom' }, d.custom.map((c, i) =>
    h('div', { class: 'row custom-row' },
      bind(h('input', { value: c.name, placeholder: '名前', 'aria-label': '項目名', autocomplete: 'off' }), (v) => (c.name = v)),
      bind(h('input', { value: c.value, placeholder: '値', 'aria-label': '値', type: c.protect ? 'password' : 'text', autocomplete: 'off' }), (v) => (c.value = v)),
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: c.protect, onchange: (ev: Event) => { c.protect = (ev.target as HTMLInputElement).checked; renderMain(); } }), '秘密'),
      // 値は入力中の最新を読む（c.value は入力のたびに更新される）
      h('button', { type: 'button', onclick: () => void copy(c.value, c.name ? `「${c.name}」` : '追加フィールドの値') }, 'コピー'),
      h('button', { type: 'button', onclick: () => { d.custom.splice(i, 1); renderMain(); } }, '削除'),
    ),
  ));

  const fileInput = h('input', { type: 'file', multiple: true, hidden: true });
  fileInput.addEventListener('change', () => void addFiles(db, entry, [...(fileInput.files ?? [])]));

  return h('section', { class: 'editor' },
    text('f-title', 'タイトル', d.title, (v) => (d.title = v)),
    text('f-user', 'ユーザー名', d.userName, (v) => (d.userName = v), [h('button', { type: 'button', onclick: () => void copy(d.userName, 'ユーザー名') }, 'コピー')]),
    h('div', { class: 'field' }, h('label', { for: 'f-password' }, 'パスワード'), h('div', { class: 'row' }, pwInput, toggle, gen, undo, h('button', { type: 'button', onclick: () => void copy(d.password, 'パスワード') }, 'コピー'))),
    text('f-url', 'URL', d.url, (v) => (d.url = v)),
    h('div', { class: 'field' }, h('label', { for: 'f-notes' }, 'メモ'), bind(h('textarea', { id: 'f-notes', rows: 4, spellcheck: 'false' }, d.notes), (v) => (d.notes = v))),
    h('div', { class: 'field' },
      h('div', { class: 'row between' }, h('span', { class: 'label' }, '追加フィールド'), h('button', { type: 'button', onclick: () => { d.custom.push({ name: '', value: '', protect: true }); renderMain(); } }, '＋ 追加')),
      custom,
    ),
    h('div', { class: 'field' },
      h('div', { class: 'row between' }, h('span', { class: 'label' }, '添付ファイル（秘密鍵など）'), h('button', { type: 'button', onclick: () => fileInput.click(), disabled: state.busy }, '＋ 追加'), fileInput),
      h('ul', { class: 'files' }, K.attachmentNames(entry).map((name) => {
        const bytes = K.attachmentBytes(entry, name);
        return h('li', { class: 'row between' },
          h('span', {}, name, h('span', { class: 'muted small' }, bytes ? ` ${formatBytes(bytes.byteLength)}` : '')),
          h('span', { class: 'row' },
            h('button', { type: 'button', onclick: () => bytes && downloadBytes(bytes, name) }, '取り出す'),
            confirmButton('削除', '本当に削除', () => true, () => { commitDraft(); K.removeAttachment(entry, name); markDirty(); state.draft = K.draftOf(entry); renderMain(); }),
          ),
        );
      })),
    ),
    h('div', { class: 'row between foot' },
      h('span', { class: 'muted small' }, `更新: ${entry.times.lastModTime?.toLocaleString('ja-JP') ?? '-'}`),
      confirmButton('項目を削除', '本当に削除（ごみ箱へ）', () => true, () => {
        K.removeEntry(db, entry);
        markDirty();
        state.selected = null;
        state.draft = null;
        renderMain();
      }),
    ),
  );
}

function refreshSaveButton() {
  const b = root.querySelector('header .actions button.primary') as HTMLButtonElement | null;
  if (!b) return;
  b.disabled = state.busy || !isDirty();
  b.textContent = isDirty() ? '保存' : '保存済み';
}

async function addFiles(db: K.Kdbx, entry: K.KdbxEntry, files: File[]) {
  commitDraft();
  for (const f of files) {
    if (estimatedSize() + f.size > MAX_VAULT_BYTES) {
      setMessage('error', `「${f.name}」（${formatBytes(f.size)}）を追加すると上限 ${formatBytes(MAX_VAULT_BYTES)} を超えます。`);
      return;
    }
    await K.addAttachment(db, entry, f.name, new Uint8Array(await f.arrayBuffer()));
    state.addedSinceSerialize += f.size;
    markDirty();
  }
  state.draft = K.draftOf(entry);
  if (estimatedSize() >= warnBytes()) setMessage('warn', `保管庫が ${formatBytes(estimatedSize())} になります。上限は ${formatBytes(MAX_VAULT_BYTES)} です。`);
  else renderMain();
}

let clipboardTimer: number | undefined;
async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    setMessage('info', `${label}をコピーしました。${CLIPBOARD_CLEAR_MS / 1000} 秒後にクリップボードを消去します。`);
    clearTimeout(clipboardTimer);
    clipboardTimer = window.setTimeout(() => void navigator.clipboard.writeText('').catch(() => {}), CLIPBOARD_CLEAR_MS);
  } catch {
    setMessage('error', 'クリップボードにコピーできませんでした。');
  }
}

// ---------------------------------------------------------------- 保存（412 のときはマージして再試行）

async function save() {
  const db = state.db;
  if (!db || state.busy) return;
  commitDraft();
  state.busy = true;
  setMessage('info', '暗号化して保存しています…');
  let merged = false;
  try {
    for (let attempt = 1; ; attempt++) {
      const bytes = await K.serialize(db);
      state.size = bytes.byteLength;
      state.addedSinceSerialize = 0;
      if (bytes.byteLength > MAX_VAULT_BYTES) {
        throw new ApiError(413, `保管庫が ${formatBytes(bytes.byteLength)} で、上限 ${formatBytes(MAX_VAULT_BYTES)} を超えています。添付ファイルを減らしてください。`);
      }
      try {
        state.etag = await storeVault(bytes, state.etag);
        K.markPushed(db);
        state.dirty = false;
        break;
      } catch (err) {
        if (!(err instanceof ConflictError) || attempt >= MAX_SAVE_ATTEMPTS) throw err;
        // 別の端末が先に保存していた：最新版を取り直して取り込み、保存し直す
        const remote = await fetchVault();
        if (!remote) throw new ApiError(404, 'サーバー上の保管庫が見つかりません。');
        try {
          await K.mergeRemote(db, remote.bytes);
        } catch (e) {
          if (e instanceof K.WrongPasswordError) {
            throw new ApiError(412, '別の端末でマスターパスワードが変更されたため、統合できません。この内容をダウンロードして保管し、再読み込みしてください。');
          }
          throw e;
        }
        state.etag = remote.etag;
        merged = true;
      }
    }
    if (state.selected) state.draft = K.draftOf(state.selected);
    state.busy = false;
    setMessage('info', merged ? '別の端末の変更を取り込んで保存しました。' : '保存しました。');
  } catch (err) {
    state.busy = false;
    if (err instanceof AuthRequiredError) {
      setMessage('error', 'ログインの有効期限が切れたため保存できませんでした。「ダウンロード」で今の内容を手元に保存してから、ログアウトしてログインし直してください。');
    } else {
      setMessage('error', errorText(err));
    }
  }
}

async function download() {
  const db = state.db;
  if (!db) return;
  commitDraft();
  state.busy = true;
  try {
    const bytes = await K.serialize(db);
    state.size = bytes.byteLength;
    state.addedSinceSerialize = 0;
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    downloadBytes(bytes, `nagi-vault-${date}.kdbx`);
    state.busy = false;
    setMessage('info', `保管庫ファイルをダウンロードしました${isDirty() ? '（未保存の変更を含みます）' : ''}。KeePassXC などで開けます。`);
  } catch (err) {
    state.busy = false;
    setMessage('error', errorText(err));
  }
}

// ---------------------------------------------------------------- CSV の取り込み

/** これより大きい CSV は取り込まない（パスワードの CSV としては十分に大きい） */
const MAX_CSV_BYTES = 10 * 1024 * 1024;

function pickCsv() {
  const input = h('input', { type: 'file', accept: '.csv,text/csv' });
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) void importCsv(f);
  });
  input.click();
}

async function importCsv(file: File) {
  const db = state.db;
  if (!db || state.busy) return;
  if (file.size > MAX_CSV_BYTES) return setMessage('error', `CSV が ${formatBytes(file.size)} で、取り込める上限 ${formatBytes(MAX_CSV_BYTES)} を超えています。`);
  if (estimatedSize() + file.size > MAX_VAULT_BYTES) return setMessage('error', `この CSV を取り込むと保管庫の上限 ${formatBytes(MAX_VAULT_BYTES)} を超えるおそれがあります。`);
  commitDraft();
  try {
    const logins = parseLoginCsv(await file.text());
    if (logins.length === 0) return setMessage('warn', 'CSV に取り込める項目がありませんでした。');
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const groupName = `インポート ${date}`;
    const { added, skipped } = K.importLogins(db, logins, groupName);
    const skippedText = skipped > 0 ? `同じ内容の項目がすでにある ${skipped} 件は飛ばしました。` : '';
    if (added === 0) return setMessage('info', `新しく取り込む項目はありませんでした。${skippedText}`);
    state.addedSinceSerialize += file.size;
    markDirty();
    state.selected = null;
    state.draft = null;
    setMessage('warn', `${added} 件を「${groupName}」グループに取り込みました。${skippedText}「保存」を押すまで保管庫には保存されません。取り込んだ CSV ファイルにはパスワードが暗号化されずに書かれているので、削除してください（ごみ箱も空にしてください）。`);
  } catch (err) {
    setMessage('error', err instanceof CsvFormatError ? err.message : errorText(err));
  }
}

// ---------------------------------------------------------------- 自動ロックと離脱時の警告

let idleTimer: number | undefined;
function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    // 未保存の変更があるときは自動ではロックしない（変更を失わないため）
    if (state.db && !isDirty() && !state.busy) lock();
    else resetIdle();
  }, IDLE_LOCK_MS);
}
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, resetIdle, { passive: true });
resetIdle();

window.addEventListener('beforeunload', (ev) => {
  if (state.db && isDirty()) ev.preventDefault();
});

void main();
