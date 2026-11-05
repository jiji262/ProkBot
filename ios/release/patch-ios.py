#!/usr/bin/env python3
"""Patch a user-supplied decrypted IPA; export unsigned files for the user's signer."""
import argparse
import importlib.util
import json
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import zipfile
from bytepatch import apply, digest, load
from native_text import text_digest

ROOT = Path(__file__).resolve().parents[1]


def extract(source, destination):
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 20000 or sum(x.file_size for x in entries) > 2 * 1024**3:
            raise ValueError('IPA exceeds supported size')
        seen = set()
        for entry in entries:
            path = Path(entry.filename)
            if path.is_absolute() or '..' in path.parts or str(path) in seen or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError('Unsafe IPA entry')
            seen.add(str(path))
            target = destination / path
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as src, target.open('wb') as dst:
                    shutil.copyfileobj(src, dst)
                target.chmod((entry.external_attr >> 16) & 0o777 or 0o644)
    apps = list((destination / 'Payload').glob('*.app'))
    if len(apps) != 1:
        raise ValueError('Expected one app in Payload')
    return apps[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True, help='Decrypted Grok Bot 1.16.0 (23152) IPA')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--bundle-id', default='dev.grokbot.local')
    parser.add_argument('--app-group', help='App Group configured in your signing account')
    parser.add_argument('--remove-extensions', action='store_true', help='Explicitly omit Live Activity, share and notification extensions')
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output exists; choose a new directory')
    manifest = json.loads((ROOT / 'recipes/ios/manifest.json').read_text())
    started = time.monotonic()
    original_digest = digest(args.input.read_bytes())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='grokbot-ios-', dir=args.output.parent) as temporary:
        work = Path(temporary)
        source = extract(args.input, work / 'source')
        info = plistlib.loads((source / 'Info.plist').read_bytes())
        if (info.get('CFBundleIdentifier'), info.get('CFBundleShortVersionString'), info.get('CFBundleVersion')) != ('co.anysphere.sand', '1.16.0', '23152'):
            raise ValueError('Unsupported app version')
        executable = Path(info['CFBundleExecutable'])
        if executable.name != str(executable):
            raise ValueError('Invalid app executable path')
        if text_digest((source / executable).read_bytes()) != manifest['nativeTextSha256']:
            raise ValueError('Unsupported native executable: SHA-256 mismatch')
        original = (source / 'main.jsbundle').read_bytes()
        if digest(original) != manifest['hbcSha256']:
            raise ValueError('Unsupported Hermes bundle: SHA-256 mismatch')
        resources = work / 'resources'
        resources.mkdir()
        for record in manifest['resources']:
            path = Path(record['target'])
            if path.is_absolute() or '..' in path.parts:
                raise ValueError('Invalid resource path')
            (resources / path).write_bytes(apply(original, load(ROOT / 'recipes/ios' / record['patch'])))
        dylib = ROOT / 'bin/GrokBotLocal.dylib'
        if digest(dylib.read_bytes()) != manifest['dylibSha256']:
            raise ValueError('Injection library checksum mismatch')
        command = [sys.executable, ROOT / 'patchers/ios/patch-app.py', '--source', source,
                   '--output', work / 'patched', '--dylib', dylib, '--resources', resources,
                   '--bundle-id', args.bundle_id, '--unsigned']
        if args.app_group:
            command += ['--app-group', args.app_group]
        if args.remove_extensions:
            command += ['--remove-extensions']
        subprocess.run([str(x) for x in command], check=True, stdout=subprocess.DEVNULL)
        report = json.loads((work / 'patched/patch-report.json').read_text())
        report.update(seconds=round(time.monotonic()-started, 3), inputSha256=original_digest,
                      signing='unsigned', originalPreserved=digest(args.input.read_bytes()) == original_digest)
        report.pop('app', None)
        report['ipa'] = 'GrokBot-Local-resignable.ipa'
        (work / 'patched/patch-report.json').write_text(json.dumps(report, indent=2)+'\n')
        # Only the IPA, our library and the report are delivered. No profile/certificate.
        shutil.rmtree(work / 'patched/Payload')
        shutil.copy2(dylib, work / 'patched/GrokBotLocal.dylib')
        shutil.move(str(work / 'patched'), str(args.output))
        print(json.dumps(report))


if __name__ == '__main__':
    main()
