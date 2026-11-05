"""Sign the app and its extensions using caller-supplied provisioning profiles."""
import plistlib
import shutil
import subprocess


def profile(path):
    return plistlib.loads(subprocess.check_output(
        ['security', 'cms', '-D', '-i', str(path)], stderr=subprocess.DEVNULL))


def allows(pattern, value):
    return pattern == value or (pattern.endswith('.*') and value.startswith(pattern[:-1]))


def entitlements(info, bundle_id, group=None, parent_id=None):
    prefix = info['ApplicationIdentifierPrefix'][0]
    allowed = info['Entitlements']
    expected = prefix + '.' + bundle_id
    if not allows(allowed['application-identifier'], expected):
        raise ValueError('Profile does not authorize ' + bundle_id)
    result = {'application-identifier': expected,
              'com.apple.developer.team-identifier': info['TeamIdentifier'][0],
              'keychain-access-groups': [expected],
              'get-task-allow': allowed.get('get-task-allow', False)}
    if group:
        if group not in allowed.get('com.apple.security.application-groups', []):
            raise ValueError('Profile for ' + bundle_id + ' must include App Group ' + group)
        shared = prefix + '.' + parent_id + '.shared'
        if not any(allows(value, shared) for value in allowed.get('keychain-access-groups', [])):
            raise ValueError('Profile does not allow the shared keychain group')
        result['com.apple.security.application-groups'] = [group]
        result['keychain-access-groups'].append(shared)
    environment = allowed.get('aps-environment')
    if environment in ('development', 'production'):
        if allowed['application-identifier'] != expected:
            raise ValueError('APNs requires an exact App ID profile')
        result['aps-environment'] = environment
    return result


def sign(app, identity, main_profile, extension_profiles, group, records, commands, output):
    bundle_id = plistlib.loads((app / 'Info.plist').read_bytes())['CFBundleIdentifier']
    targets = [(app, main_profile)] + [(app / 'PlugIns' / row['name'], extension_profiles.get(row['name']))
                                      for row in records]
    prepared = []
    team = None
    for target, path in targets:
        info = plistlib.loads((target / 'Info.plist').read_bytes())
        data = profile(path) if path else None
        if main_profile and not data:
            raise ValueError('Missing extension profile for ' + target.name)
        if data:
            current = data['TeamIdentifier'][0]
            if team and team != current:
                raise ValueError('App and extensions must use the same signing team')
            team = current
            values = entitlements(data, info['CFBundleIdentifier'], group if records else None, bundle_id)
            if records:
                info['SandKeychainAccessGroups'] = [values['keychain-access-groups'][-1]]
                (target / 'Info.plist').write_bytes(plistlib.dumps(info))
            shutil.copy2(path, target / 'embedded.mobileprovision')
        else:
            values = {'com.apple.security.application-groups': [group]} if records else {}
        prepared.append((target, values, data))
    executables = {target / plistlib.loads((target / 'Info.plist').read_bytes())['CFBundleExecutable']
                   for target, _, _ in prepared}
    for binary in sorted(app.rglob('*'), key=lambda path: -len(path.parts)):
        if binary.is_file() and binary not in executables and commands(binary.read_bytes()):
            subprocess.run(['codesign', '--force', '--sign', identity, '--timestamp=none', str(binary)],
                           check=True, capture_output=True)
    for target, values, _ in reversed(prepared):
        ep = output / (target.name + '.entitlements.plist')
        ep.write_bytes(plistlib.dumps(values))
        subprocess.run(['codesign', '--force', '--sign', identity, '--timestamp=none', '--entitlements',
                        str(ep), str(target)], check=True, capture_output=True)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True, capture_output=True)
    return prepared[0][2]
