#!/usr/bin/env python3
"""Deterministic COPY/ADD patches; original bytes are read from the user's input."""
import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path

SCHEMA = 'grokbot-bytepatch/v1'
MAX_BYTES = 512 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def index_source(source, width=32, stride=16):
    result = {}
    for offset in range(0, len(source) - width + 1, stride):
        key = source[offset:offset + width]
        # Repetitive padding needs one location, not millions of alternatives.
        candidates = result.setdefault(key, [])
        if len(candidates) < 4:
            candidates.append(offset)
    return result


def create(source, target, index=None):
    if max(len(source), len(target)) > MAX_BYTES:
        raise ValueError('Patch input exceeds supported size')
    if index is None:
        index = index_source(source)
    ops = []
    cursor = pending = 0
    while cursor < len(target):
        best_start = best_length = 0
        for offset in index.get(target[cursor:cursor + 32], []):
            length = 32
            limit = min(len(source) - offset, len(target) - cursor)
            while length + 4096 <= limit and source[offset + length:offset + length + 4096] == target[cursor + length:cursor + length + 4096]:
                length += 4096
            while length < limit and source[offset + length] == target[cursor + length]:
                length += 1
            if length > best_length:
                best_start, best_length = offset, length
        if not best_length:
            cursor += 1
            continue
        # Include the unaligned prefix in COPY, keeping it out of ADD payloads.
        while cursor > pending and best_start and source[best_start - 1] == target[cursor - 1]:
            cursor -= 1
            best_start -= 1
            best_length += 1
        if pending < cursor:
            ops.append(['add', base64.b64encode(target[pending:cursor]).decode('ascii')])
        if ops and ops[-1][0] == 'copy' and ops[-1][1] + ops[-1][2] == best_start:
            ops[-1][2] += best_length
        else:
            ops.append(['copy', best_start, best_length])
        cursor += best_length
        pending = cursor
    if pending < len(target):
        ops.append(['add', base64.b64encode(target[pending:]).decode('ascii')])
    recipe = dict(schema=SCHEMA, sourceSha256=digest(source), targetSha256=digest(target),
                  sourceBytes=len(source), targetBytes=len(target), ops=ops)
    if apply(source, recipe) != target:
        raise AssertionError('Generated patch failed round-trip')
    return recipe


def apply(source, recipe):
    if recipe.get('schema') != SCHEMA:
        raise ValueError('Unsupported patch schema')
    if len(source) != recipe['sourceBytes'] or digest(source) != recipe['sourceSha256']:
        raise ValueError('Unsupported original: SHA-256 mismatch')
    size = recipe['targetBytes']
    if type(size) is not int or not 0 <= size <= MAX_BYTES:
        raise ValueError('Invalid output size')
    result = bytearray()
    for op in recipe['ops']:
        if op[0] == 'copy' and len(op) == 3:
            start, length = op[1:]
            if type(start) is not int or type(length) is not int or start < 0 or length < 1 or start + length > len(source):
                raise ValueError('Invalid COPY range')
            data = memoryview(source)[start:start + length]
        elif op[0] == 'add' and len(op) == 2:
            data = base64.b64decode(op[1], validate=True)
        else:
            raise ValueError('Invalid patch operation')
        if len(result) + len(data) > size:
            raise ValueError('Patch output overflow')
        result.extend(data)
    if len(result) != size or digest(result) != recipe['targetSha256']:
        raise ValueError('Patch output verification failed')
    return bytes(result)


def load(path):
    with gzip.open(path, 'rb') as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('Patch exceeds supported size')
    return json.loads(data)


def save(path, recipe):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(json.dumps(recipe, separators=(',', ':')).encode(), mtime=0))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['create', 'apply'])
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--target', type=Path)
    parser.add_argument('--patch', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output already exists')
    source = args.source.read_bytes()
    if args.command == 'create':
        if not args.target:
            parser.error('create requires --target')
        save(args.output, create(source, args.target.read_bytes()))
    else:
        if not args.patch:
            parser.error('apply requires --patch')
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(apply(source, load(args.patch)))
