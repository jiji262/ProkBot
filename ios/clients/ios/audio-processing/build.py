#!/usr/bin/env python3
"""Maintainer build of pinned WebRTC APM and the Grok Bot C audio adapter."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
MIRROR = 'https://gstreamer.freedesktop.org/src/mirror/webrtc-audio-processing/'
INPUTS = [
    ('webrtc-audio-processing-1.3.tar.gz', 'webrtc-audio-processing-1.3.tar.gz',
     '95552fc17faa0202133707bbb3727e8c2cf64d4266fe31bfdb2298d769c1db75'),
    ('abseil-cpp-20230125.1.tar.gz', '20230125.1.tar.gz',
     '81311c17599b3712069ded20cca09a62ab0bf2a89dfa16993786c8782b7ed145'),
    ('abseil-cpp_20230125.1-4_patch.zip', 'abseil-cpp_20230125.1-4_patch.zip',
     '112ee72052049d930396c2778fc1c6e184137905dd75d60a97dcfc386426610d'),
]


def run(*args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def capture(*args):
    return subprocess.check_output(args, text=True).strip()


def extract(archive, destination):
    with tarfile.open(archive) as source:
        for entry in source:
            path = Path(entry.name)
            if path.is_absolute() or '..' in path.parts or not (entry.isdir() or entry.isfile()):
                raise ValueError('Unsafe archive entry')
            target = destination / path
            if entry.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(entry) as src, target.open('wb') as dst:
                    shutil.copyfileobj(src, dst)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--cache', type=Path, default=HERE / '../../../.runtime/audio-processing')
    parser.add_argument('--platform', choices=['ios', 'macos'], default='ios')
    args = parser.parse_args()
    cache = args.cache.resolve(); cache.mkdir(parents=True, exist_ok=True)
    output = args.output.resolve(); output.mkdir(parents=True, exist_ok=True)
    for filename, remote, digest in INPUTS:
        path = cache / filename
        if not path.exists():
            temporary = path.with_suffix(path.suffix + '.download')
            with urllib.request.urlopen(MIRROR + remote, timeout=60) as response, temporary.open('wb') as target:
                shutil.copyfileobj(response, target)
            if hashlib.sha256(temporary.read_bytes()).hexdigest() != digest:
                temporary.unlink(); raise ValueError(f'Input checksum mismatch: {filename}')
            temporary.replace(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError(f'Input checksum mismatch: {filename}')
    source = cache / 'webrtc-audio-processing-1.3'
    if not source.exists():
        extract(cache / INPUTS[0][0], cache)
        extract(cache / INPUTS[1][0], source / 'subprojects')
        with zipfile.ZipFile(cache / INPUTS[2][0]) as patch:
            for entry in patch.infolist():
                path = Path(entry.filename)
                if path.is_absolute() or '..' in path.parts:
                    raise ValueError('Unsafe build overlay')
                patch.extract(entry, source / 'subprojects')
    sdk_name = 'iphoneos' if args.platform == 'ios' else 'macosx'
    sdk = capture('xcrun', '--sdk', sdk_name, '--show-sdk-path')
    clang = capture('xcrun', '--sdk', sdk_name, '--find', 'clang')
    clangxx = capture('xcrun', '--sdk', sdk_name, '--find', 'clang++')
    minimum = '-miphoneos-version-min=15.1' if args.platform == 'ios' else '-mmacosx-version-min=12.0'
    flags = ['-arch', 'arm64', '-isysroot', sdk, minimum, '-ffile-prefix-map=' + str(cache) + '=/audio-source']
    cross = cache / (args.platform + '.ini')
    cross.write_text('[binaries]\nc = ' + repr(clang) + '\ncpp = ' + repr(clangxx) +
                     "\nar = 'ar'\nstrip = 'strip'\n[host_machine]\nsystem = 'darwin'\n" +
                     "cpu_family = 'aarch64'\ncpu = 'arm64'\nendian = 'little'\n[built-in options]\n" +
                     ''.join(key + ' = ' + repr(flags) + '\n' for key in ['c_args', 'cpp_args', 'c_link_args', 'cpp_link_args']))
    build = cache / ('build-' + args.platform)
    if not (build / 'build.ninja').exists():
        run('meson', 'setup', build, source, '--cross-file', cross, '--buildtype=release',
            '--default-library=static', '--wrap-mode=forcefallback')
    run('meson', 'compile', '-C', build, '-j', str(min(8, os.cpu_count() or 2)))
    wrapper = output / 'GBAudioProcessing.o'
    run(clangxx, '-std=c++17', '-O3', '-DNDEBUG', '-fvisibility=hidden', '-fvisibility-inlines-hidden',
        '-DWEBRTC_APM_DEBUG_DUMP=0', '-DWEBRTC_POSIX', '-DWEBRTC_MAC',
        *flags, '-I' + str(source), '-I' + str(source / 'webrtc'),
        '-I' + str(source / 'subprojects/abseil-cpp-20230125.1'),
        '-c', HERE / 'GBAudioProcessing.cc', '-o', wrapper)
    libraries = sorted(build.rglob('*.a'))
    target = output / 'libGBAudioProcessing.a'
    staged = output / '.libGBAudioProcessing.a.build'
    run('xcrun', 'libtool', '-static', '-o', staged, wrapper, *libraries,
        env={**os.environ, 'ZERO_AR_DATE': '1'})
    staged.replace(target)
    wrapper.unlink()
    shutil.copy2(HERE / 'GBAudioProcessing.h', output / 'GBAudioProcessing.h')
    shutil.copytree(HERE / 'licenses', output / 'licenses', dirs_exist_ok=True)
    report = {'platform': args.platform, 'architecture': 'arm64', 'sampleRates': [8000, 16000, 24000, 32000, 44100, 48000],
              'sources': [{'name': name, 'sha256': digest} for name, _, digest in INPUTS],
              'adapter': {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest()
                          for name in ['GBAudioProcessing.cc', 'GBAudioProcessing.h']},
              'compiler': capture(clangxx, '--version').splitlines()[0],
              'sdk': capture('xcrun', '--sdk', sdk_name, '--show-sdk-version'),
              'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'bytes': target.stat().st_size}
    (output / 'build.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
