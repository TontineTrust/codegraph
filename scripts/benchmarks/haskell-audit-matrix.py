#!/usr/bin/env python3
"""Reproduce the public Haskell audit matrix with one frozen engine at a time.

python3 scripts/benchmarks/haskell-audit-matrix.py ENGINE OUTPUT_DIR [CORPUS ...]
Uses fresh pinned archives and indexes; never changes a global installation.
Run the baseline and candidate commands sequentially, with different output dirs.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('engine', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('corpora', nargs='*')
    parser.add_argument('--repeat', type=int, default=3)
    parser.add_argument('--timeout', type=int, default=600)
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    manifest = json.loads((here / 'haskell-audit-corpora.json').read_text())
    names = {item['name'] for item in manifest}
    if set(args.corpora) - names or args.repeat < 3 or args.timeout <= 0:
        parser.error('Use known corpus names, at least three repetitions and a positive cap.')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    engine = args.engine.resolve()
    if not (engine / 'dist/index.js').is_file():
        parser.error('Build the isolated engine first.')
    environment = os.environ.copy()
    for key in ('HASKELL_PROFILE', 'CODEGRAPH_RESOLVE_PROFILE', 'CODEGRAPH_NO_PARALLEL_RESOLVE',
                'CODEGRAPH_RESOLVE_WORKERS', 'CODEGRAPH_SYNTH_TIMINGS', 'CODEGRAPH_PARSE_WORKERS'):
        environment.pop(key, None)
    environment['CODEGRAPH_KERNEL'] = '0'
    for item in manifest:
        name = item['name']
        if args.corpora and name not in args.corpora:
            continue
        source = output / (name + '-source')
        subprocess.run(['git', 'init', str(source)], check=True)
        subprocess.run(['git', '-C', str(source), 'fetch', '--depth=1',
                        item['repository'], item['revision']], check=True)
        for iteration in range(1, args.repeat + 1):
            tag = f'{name}-{iteration}'
            root = output / tag
            root.mkdir()
            with subprocess.Popen(['git', '-C', str(source), 'archive', item['revision']],
                                  stdout=subprocess.PIPE) as archive:
                subprocess.run(['tar', '-xf', '-', '-C', str(root)], stdin=archive.stdout, check=True)
                archive.stdout.close()
                if archive.wait() != 0:
                    raise RuntimeError('git archive failed')
            options = output / (tag + '.options.json')
            options.write_text(json.dumps(item['options'], indent=2) + '\n')
            result = output / (tag + '.json')
            command = ['node', str(here / 'haskell-corpus.cjs'), str(engine),
                       str(root), str(result), str(options)]
            print('START', tag, flush=True)
            started = time.monotonic()
            with (output / (tag + '.log')).open('w') as log:
                child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                         env=environment, start_new_session=True)
                try:
                    code = child.wait(timeout=args.timeout)
                    status = 'complete' if code == 0 else 'failed'
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        code = child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        code = child.wait()
                    status = 'timeout'
                except BaseException:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait()
                    raise
            process = dict(status=status, exitCode=code, seconds=time.monotonic() - started,
                           capSeconds=args.timeout, revision=item['revision'], command=command)
            (output / (tag + '.process.json')).write_text(json.dumps(process, indent=2) + '\n')
            print(tag, status, flush=True)
            # Keep incomplete samples visible; do not repeatedly run a workload
            # whose first attempt cannot finish within the resource budget.
            if status != 'complete':
                (output / (name + '-remaining.json')).write_text(json.dumps({
                    'omittedRepetitions': list(range(iteration + 1, args.repeat + 1)),
                    'reason': 'First incomplete attempt requires investigation before repetition.',
                }, indent=2) + '\n')
                break


if __name__ == '__main__':
    main()
