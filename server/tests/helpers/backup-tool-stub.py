"""Offline tool substitutes. Never connects to PostgreSQL, S3, or a webhook."""
import base64
import json
import os
from pathlib import Path
import shutil
import sys
import time

tool, *args = sys.argv[1:]
root = Path(os.environ["BACKUP_STUB_ROOT"]).resolve()
mode = os.environ.get("BACKUP_STUB_MODE", "")

def record(**extra):
    directory = root / "calls"
    directory.mkdir(exist_ok=True)
    (directory / f"{time.time_ns()}-{os.getpid()}.json").write_text(json.dumps({"tool": tool, "args": args, **extra}), encoding="utf-8")

def fail():
    # Intentionally dirty native stderr proves the wrapper never exposes it.
    print("fixture database-password fixture-backup-key fixture-source-key", file=sys.stderr)
    sys.exit(7)

def path(value):
    if value.startswith("source/") or value.startswith("backup/"):
        result = root / "storage" / value
        if not result.resolve().is_relative_to(root):
            fail()
        return result
    return Path(value)

if tool == "psql":
    first = sys.stdin.readline()
    if "pg_export_snapshot" in first:
        record(kind="snapshot", sql=first, passwordArgument=any("database-password" in arg for arg in args))
        print("00000001-00000002-1", flush=True)
        sys.stdin.read()
    else:
        sql = first + sys.stdin.read()
        record(kind="manifest", sql=sql)
        if mode == "manifest-failure":
            fail()
        print(os.environ["BACKUP_STUB_REFERENCES"])
elif tool == "pg_dump":
    record()
    if mode == "dump-failure":
        fail()
    sys.stdout.buffer.write(b"PGDMP-unencrypted-fixture-database-password")
elif tool == "age":
    record()
    if mode == "age-failure":
        fail()
    output = Path(args[args.index("--output") + 1])
    if "--decrypt" in args:
        payload = Path(args[-1]).read_bytes()
        if not payload.startswith(b"age-stub:"):
            fail()
        output.write_bytes(base64.b64decode(payload[len(b"age-stub:"):]))
    else:
        index = args.index("--output")
        payload = Path(args[index + 2]).read_bytes() if len(args) > index + 2 else sys.stdin.buffer.read()
        output.write_bytes(b"age-stub:" + base64.b64encode(payload))
elif tool == "mc":
    record()
    if args[0] == "stat":
        if not path(args[1]).exists():
            fail()
    elif args[0] == "cp":
        source, destination = args[-2:]
        if mode == "copy-failure" and destination.startswith("backup/") and "/media/" in destination:
            fail()
        target = path(destination)
        target.parent.mkdir(parents=True, exist_ok=True)
        if not path(source).is_file():
            fail()
        shutil.copyfile(path(source), target)
        if mode == "corrupt-copy" and destination.startswith("backup/") and "/media/" in destination:
            target.write_bytes(b"corrupt")
    elif args[0] == "cat":
        if not path(args[1]).is_file():
            fail()
        sys.stdout.buffer.write(path(args[1]).read_bytes())
    else:
        fail()
elif tool == "pg_restore":
    record()
    if not Path(args[-1]).read_bytes().startswith(b"PGDMP"):
        fail()
elif tool == "curl":
    config = sys.stdin.read()
    record(config=config)
else:
    fail()
