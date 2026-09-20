import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import type { CodeGraph } from '../src';
import type { FileRecord } from '../src/types';
import {
  buildSource, hasDriftedOnDisk, MAX_SOURCE_BYTES, readFileShape, readIndexedFileText,
} from '../src/ui-server/api/source';

vi.mock('fs', async (original) => ({ ...await original<typeof fs>() }));

describe('Viewer bounded source reads', () => {
  let root: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function fixture() {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-viewer-source-bound-')));
    const file = path.join(root, 'source.txt');
    const content = 'original\n';
    fs.writeFileSync(file, content);
    const stats = fs.statSync(file);
    const record: FileRecord = {
      path: 'source.txt', language: 'unknown', size: stats.size,
      modifiedAt: stats.mtimeMs - 2000, indexedAt: 1, nodeCount: 1,
      contentHash: createHash('sha256').update(content).digest('hex'),
    };
    const graph = { getFile: (name: string) => name === record.path ? record : null } as CodeGraph;
    return { file, record, graph };
  }

  it.each(['source', 'shape', 'corroboration', 'drift'] as const)(
    '%s rejects a source that grows after the preliminary stat', async (operation) => {
      const { file, record, graph } = fixture();
      const stat = fs.statSync;
      let grown = false;
      vi.spyOn(fs, 'statSync').mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
        const stats = stat(...args);
        if (String(args[0]) === file && !grown) {
          grown = true;
          fs.truncateSync(file, MAX_SOURCE_BYTES + 1);
        }
        return stats;
      }) as typeof fs.statSync);
      const unboundedRead = vi.spyOn(fs, 'readFileSync');

      if (operation === 'source') {
        await expect(buildSource(graph, root!, new URLSearchParams('file=source.txt&ondrift=current')))
          .rejects.toMatchObject({ code: 'bad-request', message: expect.stringContaining('too large') });
      } else if (operation === 'shape') {
        expect(readFileShape(root!, record.path, record)).toEqual({
          drift: false, totalLines: null, reason: 'The file is too large to read here.',
        });
      } else if (operation === 'corroboration') {
        expect(readIndexedFileText(graph, root!, record.path, MAX_SOURCE_BYTES)?.length ?? null).toBeNull();
      } else {
        expect(hasDriftedOnDisk(root!, record.path, record)).toBe(true);
      }
      expect(grown).toBe(true);
      expect(unboundedRead.mock.calls.filter(([requested]) => String(requested) === file)).toEqual([]);
    },
  );

  it('retains the viewer limit above the extraction limit and caller-specific smaller caps', async () => {
    const { file, record, graph } = fixture();
    fs.writeFileSync(file, 'current\n' + 'x'.repeat(2 * 1024 * 1024));
    const result = await buildSource(graph, root!, new URLSearchParams('file=source.txt&from=1&to=1&ondrift=current'));
    expect(result).toMatchObject({ drift: true, showing: 'current', lines: ['current'], totalLines: 2 });
    expect(readIndexedFileText(graph, root!, record.path, 1024)).toBeNull();
    expect(readIndexedFileText(graph, root!, record.path, MAX_SOURCE_BYTES)?.startsWith('current\n')).toBe(true);
  });
});
