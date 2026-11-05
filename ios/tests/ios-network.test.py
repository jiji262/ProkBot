#!/usr/bin/env python3
"""Compile and run native network lifecycle tests without devices or credentials."""
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class NetworkLifecycle(unittest.TestCase):
    def test_native_lifecycle(self):
        directory = ROOT / '.runtime'
        directory.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='network-tests-', suffix='.noindex', dir=directory) as temporary:
            work = Path(temporary)
            info = work / 'info.plist'
            info.write_bytes(plistlib.dumps({'CFBundleIdentifier':'dev.prokbot.network-tests'}))
            executable = work / 'network-test'
            subprocess.run(['clang','-fobjc-arc','-fblocks','-framework','Foundation','-framework','Security',
                '-Wno-nullability-completeness','-Wl,-sectcreate,__TEXT,__info_plist,'+str(info),
                str(ROOT/'tests/ios-network.test.m'),'-o',str(executable)],check=True,cwd=ROOT)
            subprocess.run([str(executable)],check=True,timeout=15)

if __name__ == '__main__':
    unittest.main()
