import * as fs from 'fs';
import * as fsp from 'fs/promises';

/** Default source ceiling for extraction and MCP; the viewer supplies its own limit. */
export const MAX_FILE_SIZE = 1024 * 1024;

/**
 * Bound the read itself, not only the later parse. A stat followed by readFile
 * still allocates without a limit if the file grows between those operations.
 * One extra byte distinguishes a source exactly at the limit from an overflow.
 * Nonblocking opens plus fstat also reject FIFOs/devices without waiting on them.
 */
export async function readSource(fullPath: string): Promise<{ content: string; stats: fs.Stats }> {
  const file = await fsp.open(fullPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error('Source is not a regular file');
    if (stats.size > MAX_FILE_SIZE) return { content: '', stats };
    let buffer = Buffer.allocUnsafe(Math.max(1, stats.size + 1));
    let length = 0;
    while (length <= MAX_FILE_SIZE) {
      if (length === buffer.length) {
        const grown = Buffer.allocUnsafe(MAX_FILE_SIZE + 1);
        buffer.copy(grown);
        buffer = grown;
      }
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_SIZE) {
      // A concurrent writer grew the file after fstat. Persist a skip marker,
      // never a partial source pretending to be a successfully parsed file.
      const latest = await file.stat();
      latest.size = Math.max(latest.size, length);
      return { content: '', stats: latest };
    }
    return { content: buffer.toString('utf8', 0, length), stats };
  } finally {
    await file.close();
  }
}

/** Synchronous reader; explicit limits preserve callers such as the 8 MiB viewer. */
export function readSourceSync(fullPath: string, maxBytes = MAX_FILE_SIZE): { content: string; stats: fs.Stats } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('Source read limit must be a positive safe integer');
  }
  const fd = fs.openSync(fullPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) throw new Error('Source is not a regular file');
    if (stats.size > maxBytes) return { content: '', stats };
    let buffer = Buffer.allocUnsafe(Math.max(1, stats.size + 1));
    let length = 0;
    while (length <= maxBytes) {
      if (length === buffer.length) {
        const grown = Buffer.allocUnsafe(maxBytes + 1);
        buffer.copy(grown);
        buffer = grown;
      }
      const bytesRead = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) {
      const latest = fs.fstatSync(fd);
      latest.size = Math.max(latest.size, length);
      return { content: '', stats: latest };
    }
    return { content: buffer.toString('utf8', 0, length), stats };
  } finally {
    fs.closeSync(fd);
  }
}

/** Source-serving reads must reject oversized input, never render the skip sentinel. */
export function readSourceTextSync(fullPath: string): string {
  const source = readSourceSync(fullPath);
  if (source.stats.size > MAX_FILE_SIZE) throw new Error('Source exceeds the 1 MiB read limit');
  return source.content;
}
