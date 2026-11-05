"""Preserve the shipped extensions and isolate their storage and app links."""
import hashlib
import plistlib
import re
import struct

EXTENSIONS = {
    'Widgets.appex': ('widgets', '5b0d5f5f4453f17f5f10cc3ecd78fc7a484f16de314191d725ed8342c4ca1682'),
    'ImageShareExtension.appex': ('share', '6d178828c60621193dabf9b5235af1ee2f28936995aa34f34bb0f1f9b122fb6c'),
    'NotificationService.appex': ('NotificationService', '54edfb6a5eea656681caf5056fc6f510351cd67579ad1e4c158942babd0bf49d'),
}


def identifier(value):
    if not re.fullmatch(r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+', value):
        raise ValueError('Invalid bundle or App Group identifier')
    return value


def text_section(data, commands):
    for command, offset, size in commands(data):
        if command in (0x21, 0x2c) and struct.unpack_from('<I', data, offset + 16)[0]:
            raise ValueError('Extensions must also be decrypted; use --remove-extensions only to explicitly omit them')
        if command == 0x19:
            for index in range(struct.unpack_from('<I', data, offset + 64)[0]):
                section = offset + 72 + 80 * index
                if data[section:section + 16].rstrip(b'\0') == b'__text':
                    length = struct.unpack_from('<Q', data, section + 40)[0]
                    start = struct.unpack_from('<I', data, section + 48)[0]
                    result = (start, length)
    if 'result' not in locals():
        raise ValueError('Extension has no text section')
    return result


def prepare_extensions(app, bundle_id, group, commands):
    plugins = app / 'PlugIns'
    if not plugins.exists():
        raise ValueError('Missing original extensions; provide the complete IPA or explicitly use --remove-extensions')
    if {p.name for p in plugins.iterdir()} != set(EXTENSIONS):
        raise ValueError('Expected all three original 1.16.0 extensions')
    records = []
    for name, (suffix, expected) in EXTENSIONS.items():
        extension = plugins / name
        info = plistlib.loads((extension / 'Info.plist').read_bytes())
        if info['CFBundleIdentifier'] != 'co.anysphere.sand.' + suffix:
            raise ValueError('Unexpected extension bundle ID: ' + name)
        executable = info['CFBundleExecutable']
        if '/' in executable or executable in ('.', '..'):
            raise ValueError('Invalid extension executable')
        path = extension / executable
        data = bytearray(path.read_bytes())
        start, length = text_section(data, commands)
        if hashlib.sha256(data[start:start + length]).hexdigest() != expected:
            raise ValueError('Unsupported original extension: ' + name)
        if name == 'Widgets.appex':
            # Original GrokBotActionURL builds a seven-character Swift string.
            # Keep its ABI/length and change only the four MOV-wide immediates.
            offset = start + (0x1f9bc - 0x4000)
            for index, part in enumerate((0x6267, 0x6f6c, 0x6163, 0x6c)):
                instruction = struct.unpack_from('<I', data, offset + index * 4)[0]
                instruction = (instruction & ~(0xffff << 5)) | (part << 5)
                struct.pack_into('<I', data, offset + index * 4, instruction)
        elif name == 'ImageShareExtension.appex':
            # Equal-length replacement also preserves the original CFString size.
            if data.count(b'sand-mobile\0') != 1:
                raise ValueError('Unexpected original share URL scheme')
            data = data.replace(b'sand-mobile\0', b'gblocal-ios\0')
        path.write_bytes(data)
        info['CFBundleIdentifier'] = bundle_id + '.' + suffix
        info['SandAppGroupIdentifier'] = group
        info.pop('UISupportedDevices', None)
        (extension / 'Info.plist').write_bytes(plistlib.dumps(info))
        records.append({'name': name, 'bundleId': info['CFBundleIdentifier'],
                        'sourceTextSha256': expected, 'appGroup': group})
    return records
