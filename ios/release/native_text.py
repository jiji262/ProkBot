"""Identify the supported arm64 executable independently of its signing envelope."""
import hashlib
import struct


def text_digest(data):
    if len(data) < 32 or data[:4] != b'\xcf\xfa\xed\xfe' or struct.unpack_from('<I', data, 4)[0] != 0x100000c:
        raise ValueError('Expected thin arm64 executable')
    limit = 32 + struct.unpack_from('<I', data, 20)[0]
    offset = 32
    if limit > len(data):
        raise ValueError('Truncated Mach-O')
    text_range = None
    for _ in range(struct.unpack_from('<I', data, 16)[0]):
        if offset + 8 > limit:
            raise ValueError('Invalid Mach-O load commands')
        command, size = struct.unpack_from('<II', data, offset)
        if size < 8 or offset + size > limit:
            raise ValueError('Invalid Mach-O command')
        if command in (0x21, 0x2c):
            if size < 20:
                raise ValueError('Invalid encryption command')
            if struct.unpack_from('<I', data, offset+16)[0]:
                raise ValueError('Encrypted input; provide a decrypted IPA')
        if command == 0x19:
            if size < 72:
                raise ValueError('Invalid segment command')
            count = struct.unpack_from('<I', data, offset+64)[0]
            if size < 72 + count * 80:
                raise ValueError('Invalid segment sections')
            for index in range(count):
                section = offset + 72 + index * 80
                name = data[section:section+16].rstrip(b'\0')
                segment = data[section+16:section+32].rstrip(b'\0')
                if name == b'__text' and segment == b'__TEXT':
                    length = struct.unpack_from('<Q', data, section+40)[0]
                    start = struct.unpack_from('<I', data, section+48)[0]
                    if not length or start + length > len(data):
                        raise ValueError('Invalid executable text range')
                    if text_range is not None:
                        raise ValueError('Duplicate executable text')
                    text_range = (start, length)
        offset += size
    if text_range is None:
        raise ValueError('Missing executable text')
    start, length = text_range
    return hashlib.sha256(data[start:start+length]).hexdigest()
