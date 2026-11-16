import { describe, expect, it } from 'vitest';
import { CsvFormatError, parseCsv, parseLoginCsv } from '../src/csv-import';
import * as K from '../src/kdbx';

describe('parseCsv', () => {
  it('引用符の中のカンマ・改行・"" と CRLF・BOM を扱う', () => {
    const text = '﻿a,b,c\r\n"x,1","he said ""hi""","line1\nline2"\r\n\r\nlast,,\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x,1', 'he said "hi"', 'line1\nline2'],
      ['last', '', ''],
    ]);
  });

  it('最終行に改行がなくても読む', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('閉じていない引用符はエラー', () => {
    expect(() => parseCsv('a\n"oops')).toThrow(CsvFormatError);
  });
});

describe('parseLoginCsv', () => {
  it('Chrome・Brave の形式（name,url,username,password,note）', () => {
    const csv = 'name,url,username,password,note\nexample.com,https://example.com/login,alice,p@ss,"memo, 1"\n,https://foo.example.org/,bob,x,\n';
    expect(parseLoginCsv(csv)).toEqual([
      { title: 'example.com', url: 'https://example.com/login', userName: 'alice', password: 'p@ss', notes: 'memo, 1' },
      { title: 'foo.example.org', url: 'https://foo.example.org/', userName: 'bob', password: 'x', notes: '' },
    ]);
  });

  it('Firefox の形式（列の順番が違い、name がない）', () => {
    const csv = '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"https://a.example","u","pw",,"https://a.example","{1}","1","1","1"\n';
    expect(parseLoginCsv(csv)).toEqual([{ title: 'a.example', url: 'https://a.example', userName: 'u', password: 'pw', notes: '' }]);
  });

  it('パスワードの列がない CSV はエラー', () => {
    expect(() => parseLoginCsv('foo,bar\n1,2\n')).toThrow(CsvFormatError);
  });
});

describe('importLogins', () => {
  it('新しいグループに追加し、同じ内容の項目は飛ばす', () => {
    const db = K.createVault('test-password-123');
    const existing = K.newEntry(db);
    existing.fields.set('URL', 'https://a.example');
    existing.fields.set('UserName', 'u');
    existing.fields.set('Password', K.ProtectedValue.fromString('pw'));
    const logins = [
      { title: 'a', url: 'https://a.example', userName: 'u', password: 'pw', notes: '' },
      { title: 'b', url: 'https://b.example', userName: 'v', password: 'pw2', notes: 'n' },
      { title: 'b', url: 'https://b.example', userName: 'v', password: 'pw2', notes: 'n' },
    ];
    const r = K.importLogins(db, logins, 'インポート');
    expect(r).toMatchObject({ added: 1, skipped: 2 });
    const imported = K.listEntries(db).find((e) => K.fieldText(e, 'Title') === 'b')!;
    expect(K.groupPath(db, imported)).toBe('インポート');
    expect(K.isProtected(imported, 'Password')).toBe(true);
    expect(K.fieldText(imported, 'Notes')).toBe('n');
  });

  it('すべて重複ならグループを作らない', () => {
    const db = K.createVault('test-password-123');
    const before = db.getDefaultGroup().groups.length;
    const r = K.importLogins(db, [], 'インポート');
    expect(r.added).toBe(0);
    expect(db.getDefaultGroup().groups.length).toBe(before);
  });
});
