#!/usr/bin/env python3
"""Copy a decrypted original app and add the local Host dylib for re-signing.

Never edits the source. Encrypted binaries are rejected, never cleared. An
explicit --remove-extensions omits all three original extensions.
Without --identity the output is ad-hoc signed and must be re-signed to install.
The public entry uses --unsigned and never accesses signing assets.
"""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import struct
import zipfile
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extensions import identifier, prepare_extensions
from signing import sign

ROOT=Path(__file__).resolve().parents[2]

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()

def disable_expo_updates(app):
    """Use the patched embedded bundle, including when upgrading an old install.

    Expo's persisted launch asset survives app replacement and re-signing. A
    cache created by an earlier build must never override our bundled HBC.
    Disabling Updates selects Expo's no-database embedded launcher; it leaves
    the user's container and its existing cache untouched.
    """
    path=app/'Expo.plist'
    if not path.is_file():raise ValueError('Supported app is missing Expo.plist')
    config=plistlib.loads(path.read_bytes())
    config.update(EXUpdatesEnabled=False,EXUpdatesCheckOnLaunch='NEVER',
                  EXUpdatesLaunchWaitMs=0,EXUpdatesHasEmbeddedUpdate=True)
    for key in ('EXUpdatesURL','EXUpdatesRequestHeaders',
                'EXUpdatesCodeSigningCertificate','EXUpdatesCodeSigningMetadata'):
        config.pop(key,None)
    path.write_bytes(plistlib.dumps(config))

def commands(data):
    if data[:4] in (b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca', b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca'):
        raise ValueError('Universal Mach-O is unsupported; provide the arm64 slice')
    if data[:4]!=b'\xcf\xfa\xed\xfe':return []
    if len(data)<32:raise ValueError('Truncated Mach-O header')
    limit=32+struct.unpack_from('<I',data,20)[0]
    if limit>len(data):raise ValueError('Truncated Mach-O load commands')
    offset=32;result=[]
    for _ in range(struct.unpack_from('<I',data,16)[0]):
        if offset+8>limit:raise ValueError('Malformed Mach-O command count')
        cmd,size=struct.unpack_from('<II',data,offset)
        if size<8 or offset+size>limit:raise ValueError('Malformed Mach-O')
        result.append((cmd,offset,size));offset+=size
    if offset!=limit:raise ValueError('Malformed Mach-O command size')
    return result

def inject(path,library):
    data=bytearray(path.read_bytes());cmds=commands(data)
    if not cmds:raise ValueError('Expected arm64 Mach-O')
    if struct.unpack_from('<I',data,4)[0]!=0x100000c:raise ValueError('Expected arm64 architecture')
    if any(cmd in (0x21,0x2c) and struct.unpack_from('<I',data,off+16)[0] for cmd,off,size in cmds):raise ValueError('Encrypted Mach-O; provide a genuinely decrypted input')
    end=32+struct.unpack_from('<I',data,20)[0]
    sections=[]
    for cmd,off,size in cmds:
        if cmd==0x19:
            for i in range(struct.unpack_from('<I',data,off+64)[0]):
                section=off+72+80*i
                fileoff=struct.unpack_from('<I',data,section+48)[0]
                if fileoff:sections.append(fileoff)
    if not sections:raise ValueError('Mach-O has no file-backed sections')
    first=min(sections);name=library.encode()+b'\0';length=(24+len(name)+7)&~7
    if end+length>first or any(data[end:end+length]):raise ValueError('Insufficient zero header padding for dylib command')
    command=struct.pack('<IIIIII',0xc,length,24,0,0,0)+name
    data[end:end+length]=command.ljust(length,b'\0')
    struct.pack_into('<I',data,16,len(cmds)+1);struct.pack_into('<I',data,20,end-32+length)
    path.write_bytes(data)

def remove_signature(path):
    """Erase signing metadata without moving any file-backed Mach-O section."""
    data=bytearray(path.read_bytes());cmds=commands(data)
    kept=[bytes(data[off:off+size]) for cmd,off,size in cmds if cmd!=0x1d]
    if len(kept)==len(cmds):return
    old_size=struct.unpack_from('<I',data,20)[0]
    for cmd,off,size in cmds:
        if cmd!=0x1d:continue
        if size!=16:raise ValueError('Malformed code signature command')
        start,length=struct.unpack_from('<II',data,off+8)
        if start<32+old_size or start+length>len(data):
            raise ValueError('Code signature data outside binary')
        data[start:start+length]=bytes(length)
    body=b''.join(kept)
    data[32:32+old_size]=body.ljust(old_size,b'\0')
    struct.pack_into('<I',data,16,len(kept));struct.pack_into('<I',data,20,len(body))
    path.write_bytes(data)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--dylib',type=Path,required=True);p.add_argument('--resources',type=Path,required=True)
    p.add_argument('--bundle-id',default='dev.grokbot.local');p.add_argument('--display-name',default='Grok Bot')
    p.add_argument('--remove-extensions',action='store_true');p.add_argument('--app-only',action='store_true')
    p.add_argument('--without-injection',action='store_true',
                   help='Prepare scripts/resources for a phone injection tool; keep the executable uninjected')
    p.add_argument('--identity');p.add_argument('--profile',type=Path)
    p.add_argument('--app-group',help='Shared App Group; defaults to group.<bundle-id>')
    p.add_argument('--extension-profiles',type=Path,help='JSON mapping extension directory names to existing profile paths')
    p.add_argument('--unsigned',action='store_true',help='Export without signing or accessing certificates')
    a=p.parse_args()
    if a.output.exists():raise ValueError('Output exists')
    if not a.dylib.is_file() or not (a.resources/'gateway-template.hbc').is_file():raise ValueError('Build the dylib and template first')
    if bool(a.identity)!=bool(a.profile):raise ValueError('Provide identity and existing profile together')
    if a.unsigned and (a.identity or a.profile):raise ValueError('Unsigned export cannot use signing credentials')
    identifier(a.bundle_id)
    group=identifier(a.app_group or 'group.'+a.bundle_id)
    extension_profiles=json.loads(a.extension_profiles.read_text()) if a.extension_profiles else {}
    if not isinstance(extension_profiles,dict):raise ValueError('Expected extension profile mapping')
    original=plistlib.loads((a.source/'Info.plist').read_bytes());executable=original['CFBundleExecutable']
    if original.get('CFBundleIdentifier')!='co.anysphere.sand' or original.get('CFBundleShortVersionString')!='1.16.0' or original.get('CFBundleVersion')!='23152':raise ValueError('Unsupported original app')
    if a.bundle_id==original['CFBundleIdentifier']:raise ValueError('Use an independent bundle ID to preserve the installed original')
    before=sha(a.source/executable);a.output.mkdir(parents=True,mode=0o700)
    app=a.output/'Payload'/a.source.name;shutil.copytree(a.source,app,symlinks=True)
    removed=[]
    if (app/'PlugIns').exists() and a.remove_extensions:
        removed=[x.name for x in (app/'PlugIns').iterdir()];shutil.rmtree(app/'PlugIns')
    extensions=[] if a.remove_extensions else prepare_extensions(app,a.bundle_id,group,commands)
    for pth in app.rglob('*'):
        if not pth.is_file():continue
        data=pth.read_bytes()
        for cmd,off,size in commands(data):
            if cmd in (0x21,0x2c) and struct.unpack_from('<I',data,off+16)[0]:raise ValueError('Encrypted binary remains: '+str(pth.relative_to(app)))
    for dirname in ['_CodeSignature','SC_Info']:
        for pth in sorted(app.rglob(dirname),reverse=True):shutil.rmtree(pth)
    for pth in app.rglob('embedded.mobileprovision'):pth.unlink()
    info=original.copy();info['CFBundleIdentifier']=a.bundle_id;info['CFBundleDisplayName']=a.display_name
    # The exported arm64 slice is CPU-compatible with newer iPhones. Remove only
    # the App Store thinning allowlist in the derivative; runtime assets are verified on device.
    info.pop('UISupportedDevices',None)
    info['CFBundleURLTypes']=[{'CFBundleURLSchemes':['grokbot-local','gblocal','gblocal-ios'],'CFBundleURLName':a.bundle_id}]
    info['SandAppGroupIdentifier']=group
    info.pop('GrokBotPresenceAppGroup',None)
    # Retain the original icon resources; cloud push is configured separately.
    info['NSAppTransportSecurity']={'NSAllowsArbitraryLoads':True,'NSAllowsLocalNetworking':True}
    info['NSLocalNetworkUsageDescription']='连接你配置的局域网 Host，接收消息并查看执行电脑。'
    if isinstance(info.get('Braze'),dict):info['Braze']={**info['Braze'],'UseBrazePush':False,'RequestPushPermissionsAutomatically':False}
    (app/'Info.plist').write_bytes(plistlib.dumps(info))
    disable_expo_updates(app)
    frameworks=app/'Frameworks';frameworks.mkdir(exist_ok=True)
    if not a.without_injection:shutil.copy2(a.dylib,frameworks/'GrokBotLocal.dylib')
    shutil.copytree(a.resources,frameworks/'GrokBotLocal.bundle')
    unpaired=a.resources/'unpaired.hbc'
    if not unpaired.is_file():raise ValueError('Missing native-style onboarding bundle')
    shutil.copy2(unpaired,app/'main.jsbundle')
    if not a.without_injection:inject(app/executable,'@executable_path/Frameworks/GrokBotLocal.dylib')
    profile_info=None
    binaries=[x for x in app.rglob('*') if x.is_file() and commands(x.read_bytes()) and x!=app/executable]
    if a.unsigned:
        for binary in [*binaries,app/executable]:remove_signature(binary)
    else:
        profile_info=sign(app,a.identity or '-',a.profile,extension_profiles,group,extensions,commands,a.output)
    if extensions:
        (a.output/'extension-signing.json').write_text(json.dumps({
            'appGroup':group,'appBundleId':a.bundle_id,'extensions':extensions,
            'sharedKeychainGroup':'<AppIdentifierPrefix>.'+a.bundle_id+'.shared',
            'infoPlistSharedKeychainKey':'SandKeychainAccessGroups',
            'infoPlistSharedKeychainTargets':['main',*[row['name'] for row in extensions]],
            'profileRequiredForEveryBundle':True},indent=2)+'\n')
    ipa=None
    if not a.app_only:
        ipa=a.output/'GrokBot-Local-resignable.ipa'
        with zipfile.ZipFile(ipa,'w',zipfile.ZIP_DEFLATED) as z:
            for file in app.rglob('*'):
                if file.is_file():z.write(file,file.relative_to(a.output))
    if sha(a.source/executable)!=before:raise ValueError('Original source changed')
    report={'schema':'grokbot-ios-app-patch/v1','app':str(app.resolve()),'ipa':str(ipa.resolve()) if ipa else None,'bundleId':a.bundle_id,'sourceBinarySha256':before,'patchedBinarySha256':sha(app/executable),'dylibSha256':sha(a.dylib),'dylibInjected':not a.without_injection,'originalPreserved':True,'encryptedBinaries':0,'removedExtensions':removed,'expoUpdatesEnabled':False,'signing':'existing-development-profile' if a.identity else 'ad-hoc-requires-resigning','profileName':profile_info.get('Name') if profile_info else None,'deviceVerified':False}
    report['preservedExtensions']=extensions
    if a.unsigned:report.update(signing='unsigned',profileName=None)
    (a.output/'patch-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
if __name__=='__main__':main()
