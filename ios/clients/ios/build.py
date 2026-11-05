#!/usr/bin/env python3
"""Compile the injection library for iOS arm64 without Apple account access."""
import argparse
import json
from pathlib import Path
import subprocess
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--output',type=Path,default=ROOT/'.runtime/ios-native-build')
p.add_argument('--legacy-voice',action='store_true',help='Build turn-taking voice without the client AEC3 module')
a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
sdk=subprocess.check_output(['xcrun','--sdk','iphoneos','--show-sdk-path'],text=True).strip()
output=a.output/'GrokBotLocal.dylib'
cmd=['xcrun','--sdk','iphoneos','clang','-arch','arm64','-isysroot',sdk,'-miphoneos-version-min=15.1','-dynamiclib','-fobjc-arc','-fblocks','-O2','-Wall','-Wextra','-Werror','-Wno-unused-parameter','-Wno-deprecated-declarations','-Wno-nullability-completeness','-install_name','@executable_path/GrokBotLocal.dylib','-framework','AVFoundation','-framework','CoreGraphics','-framework','Foundation','-framework','UIKit','-framework','Security','-framework','UserNotifications','-framework','PhotosUI','-framework','QuickLook','-framework','UniformTypeIdentifiers']
cmd += [str(ROOT/'clients/ios'/f) for f in ['GBNetworkScanner.m','GBNetwork.m','GBPrivacy.m','GBLocalize.m','GBUsage.m','GBHTTP.m','GBHermes.m','GBConnection.m','GBAppIntents.m','GBNotifications.m','GBPush.m','GBConnectors.m','GBSharing.m','GBSpeech.m','GBVoice.m','GBVoiceSocket.m','GBVoiceAudio.m','GBVoiceCredential.m','GBDeepLinks.m','GBLibrary.m','GBProfile.m','GBComputers.m','GBBootstrap.m','GBDiagnostics.m']]
archive = ROOT/'.runtime/tailcat-ios/libGrokTailcat.a'
if not archive.is_file() or any(f.stat().st_mtime > archive.stat().st_mtime for f in (ROOT/'network/tailcat').rglob('*') if f.is_file()):
    subprocess.run(['python3', str(ROOT/'network/build-tailcat.py'), '--target', 'ios-arm64', '--output', str(archive.parent)], check=True)
if not a.legacy_voice:
    audio_archive = ROOT/'clients/ios/audio-processing/prebuilt/ios-arm64/libGBAudioProcessing.a'
    cmd += ['-DGROKBOT_VOICE_AEC3=1',str(ROOT/'clients/ios/GBVoiceEcho.m'),str(audio_archive),'-lc++']
cmd += [str(archive), '-framework', 'CoreFoundation', '-framework', 'SystemConfiguration', '-lresolv']
subprocess.run(cmd+['-o',str(output)],check=True)
subprocess.run(['xcrun','strip','-S',str(output)],check=True)
subprocess.run(['codesign','--force','--sign','-',str(output)],check=True)
subprocess.run(['codesign','--verify','--strict',str(output)],check=True)
print(json.dumps({'dylib':str(output),'architecture':'arm64','audioProcessing':'legacy' if a.legacy_voice else 'native-aec3-buffered-v1','signing':'ad-hoc; re-sign with the containing app for non-jailbroken installation','appleAccountAccess':False}))
