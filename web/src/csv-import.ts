// ブラウザのパスワードマネージャーが書き出した CSV を読む（Chrome・Brave・Edge・Firefox など）。
// CSV は平文のパスワードを含むので、読んだ内容はこのページの中だけで使う（HANDOFF 3.4）。

export type ImportedLogin = {
  title: string;
  url: string;
  userName: string;
  password: string;
  notes: string;
};

export class CsvFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvFormatError';
  }
}

/** RFC 4180 の CSV を行の配列にする（引用符の中のカンマ・改行・"" に対応。先頭の BOM は除く） */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += c;
      }
      i++;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' || c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else field += c;
    i++;
  }
  if (quoted) throw new CsvFormatError('CSV の引用符（"）が閉じられていません。');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // 空行は除く
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** 見出しの名前（小文字）と、取り込み先の対応。左にあるものほど優先する */
const COLUMNS: Record<keyof ImportedLogin, string[]> = {
  title: ['name', 'title'],
  url: ['url', 'login_uri', 'website'],
  userName: ['username', 'login_username', 'user name', 'login'],
  password: ['password', 'login_password'],
  notes: ['note', 'notes', 'comment', 'comments'],
};

/** 見出し行で列を判断して、ログイン情報の一覧にする */
export function parseLoginCsv(text: string): ImportedLogin[] {
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header) throw new CsvFormatError('CSV が空です。');
  const names = header.map((s) => s.trim().toLowerCase());
  const index = {} as Record<keyof ImportedLogin, number>;
  for (const [key, aliases] of Object.entries(COLUMNS) as [keyof ImportedLogin, string[]][]) {
    index[key] = aliases.map((a) => names.indexOf(a)).find((n) => n >= 0) ?? -1;
  }
  if (index.password < 0 || (index.url < 0 && index.userName < 0)) {
    throw new CsvFormatError('パスワードの CSV として読めません（password と、url か username の列が必要です）。');
  }
  const get = (r: string[], key: keyof ImportedLogin) => (index[key] >= 0 ? (r[index[key]] ?? '') : '');
  return rows
    .map((r) => {
      const url = get(r, 'url').trim();
      return {
        title: get(r, 'title').trim() || hostOf(url) || url,
        url,
        userName: get(r, 'userName'),
        password: get(r, 'password'),
        notes: get(r, 'notes'),
      };
    })
    .filter((l) => l.url || l.userName || l.password);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
