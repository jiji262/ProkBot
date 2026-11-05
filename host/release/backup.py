#!/usr/bin/env python3
"""Back up a Compose project's volumes, or restore them into a new project."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import time

DOCKER = shutil.which('docker') or '/usr/local/bin/docker'


def run(*args, **kwargs):
    return subprocess.run([DOCKER, *args], check=True, **kwargs)


def output(*args):
    return subprocess.check_output([DOCKER, *args], text=True).strip()


def sha(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024*1024), b''):
            result.update(block)
    return result.hexdigest()


def backup(project, destination, image):
    if destination.exists():
        raise ValueError('Backup destination exists')
    volumes = output('volume', 'ls', '--filter', f'label=com.docker.compose.project={project}', '--format', '{{.Name}}').splitlines()
    if not volumes:
        raise ValueError('No named Compose volumes found')
    running = output('ps', '--filter', f'label=com.docker.compose.project={project}', '--filter', 'status=running', '--format', '{{.ID}}').splitlines()
    destination.mkdir(parents=True, mode=0o700)
    paused = []
    records = []
    try:
        for container in running:
            if output('inspect', container, '--format', '{{.State.Paused}}') == 'false':
                run('pause', container, stdout=subprocess.DEVNULL)
                paused.append(container)
        for volume in volumes:
            if not volume.startswith(project+'_') or not re.fullmatch(r'[A-Za-z0-9_.-]+', volume):
                raise ValueError('Unexpected volume name')
            path = destination / (volume+'.tar.gz')
            with path.open('wb') as target:
                run('run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'tar', '-v', volume+':/backup:ro', image,
                    '-czf', '-', '-C', '/backup', '.', stdout=target)
            path.chmod(0o600)
            records.append({'name': volume, 'suffix': volume[len(project)+1:], 'file': path.name, 'sha256': sha(path), 'bytes': path.stat().st_size})
    finally:
        for container in paused:
            run('unpause', container, stdout=subprocess.DEVNULL)
    manifest = {'schema':'grokbot-volumes/v1', 'project':project, 'image':image,
                'at':time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'volumes':records}
    (destination/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    (destination/'manifest.json').chmod(0o600)
    print(json.dumps({'backup':str(destination), 'volumes':len(records), 'containersResumed':len(paused)}))


def restore(source, project, image):
    manifest = json.loads((source/'manifest.json').read_text())
    if manifest.get('schema') != 'grokbot-volumes/v1':
        raise ValueError('Unsupported backup format')
    prepared = []
    for record in manifest['volumes']:
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', record['suffix']) or Path(record['file']).name != record['file']:
            raise ValueError('Invalid backup filename')
        path = source/record['file']; name = project+'_'+record['suffix']
        if sha(path) != record['sha256']:
            raise ValueError('Backup checksum mismatch: '+record['file'])
        exists = subprocess.run([DOCKER, 'volume', 'inspect', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        if exists:
            raise ValueError('Restore target already exists: '+name)
        prepared.append((path, name, record['suffix']))
    for path, name, suffix in prepared:
        run('volume','create','--label',f'com.docker.compose.project={project}','--label',f'com.docker.compose.volume={suffix}',name, stdout=subprocess.DEVNULL)
        with path.open('rb') as source_file:
            run('run','--rm','-i','--network','none','--read-only','--entrypoint','tar','-v',name+':/restore',image,
                '-xzf','-','-C','/restore', stdin=source_file)
    print(json.dumps({'restoredProject':project,'volumes':len(prepared),'servicesStarted':False}))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation',choices=['backup','restore'])
    parser.add_argument('--project',required=True)
    parser.add_argument('--directory',required=True,type=Path)
    parser.add_argument('--image',default='grokbot-host:local')
    args=parser.parse_args()
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,60}',args.project):
        parser.error('Invalid Compose project name')
    if args.operation=='backup':
        backup(args.project,args.directory,args.image)
    else:
        restore(args.directory,args.project,args.image)


if __name__=='__main__':
    main()
