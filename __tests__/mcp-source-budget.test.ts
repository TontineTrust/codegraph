import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src';
import { ToolHandler } from '../src/mcp/tools';

vi.mock('fs', async (original) => ({ ...await original<typeof fs>() }));

describe('MCP source read budget after indexing', () => {
  let root: string;
  let graph: CodeGraph | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    graph?.destroy();
    graph = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  async function setup() {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-source-budget-')));
    const file = path.join(root, 'Audit.hs');
    fs.writeFileSync(file, 'module Audit where\nauditTarget x = x\nauditCaller x = auditTarget x\n');
    graph = CodeGraph.initSync(root);
    expect((await graph.indexAll()).success).toBe(true);
    return { file, current: graph };
  }
  it.each([
    ['codegraph_node', { symbol: 'auditTarget', includeCode: true }],
    ['codegraph_node', { symbol: 'Audit.hs' }],
    ['codegraph_explore', { query: 'auditCaller auditTarget' }],
  ] as const)('%s bounds a source that grew after indexing (%j)', async (tool, args) => {
    const { file, current } = await setup();
    fs.writeFileSync(file, '-- OVERSIZED_SOURCE_SENTINEL\n');
    fs.truncateSync(file, 2 * 1024 * 1024);
    const read = vi.spyOn(fs, 'readFileSync');
    const response = await new ToolHandler(current).execute(tool, args);
    expect(response.isError).toBeFalsy();
    expect(response.content.map(item => item.type === 'text' ? item.text : '').join('\n'))
      .not.toContain('OVERSIZED_SOURCE_SENTINEL');
    expect(read.mock.calls.filter(([name]) => String(name) === file)).toEqual([]);
  });
  it.runIf(process.platform !== 'win32')('keeps the source boundary strict after a symlink replacement', async () => {
    const { file, current } = await setup();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'Secret.hs'), 'module Secret where\nprivateOutsideSentinel = 1\n');
      fs.unlinkSync(file);
      fs.symlinkSync(path.join(outside, 'Secret.hs'), file);
      const response = await new ToolHandler(current).execute('codegraph_explore', { query: 'auditCaller auditTarget' });
      expect(response.content.map(item => item.type === 'text' ? item.text : '').join('\n'))
        .not.toContain('privateOutsideSentinel');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
