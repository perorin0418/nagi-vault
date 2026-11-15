# Phase 0 補助: 独立実装 pykeepass で kdbxweb 製ファイルを開き、逆に pykeepass で作ったファイルを用意する
# （KeePassXC 本体での確認の代わりではない。KeePassXC での確認は verify-keepassxc.sh を使う）
import sys, pathlib
from pykeepass import PyKeePass, create_database
out = pathlib.Path(__file__).parent / "out"
PW = "correct horse battery staple"
for name in ["created-hashwasm.kdbx", "created-noble.kdbx"]:
    kp = PyKeePass(str(out / name), password=PW)
    e = kp.find_entries(title="example", first=True)
    att = e.attachments[0]
    print(f"{name}: kdf={kp.kdf_algorithm} ver={kp.version} pass_ok={e.password=='s3cr3t-P@ss'} "
          f"notes_ok={e.notes=='日本語メモ'} custom_ok={e.get_custom_property('CustomField')=='custom-protected'} "
          f"attachment={att.filename} startswith_pem={att.data.startswith(b'-----BEGIN OPENSSH')}")
p = out / "external-pykeepass.kdbx"
p.unlink(missing_ok=True)
kp = create_database(str(p), password=PW)
e = kp.add_entry(kp.root_group, "from-pykeepass", "bob", "py-pass")
bid = kp.add_binary(b"binary-from-pykeepass")
e.add_attachment(bid, "py.bin")
kp.save()
print("wrote", p.name, "kdf=", PyKeePass(str(p), password=PW).kdf_algorithm)
