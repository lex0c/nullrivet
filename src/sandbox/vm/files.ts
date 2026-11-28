import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

// Reads a regular file whole, without blocking on a FIFO, up to `max` bytes.
export const readBounded = (path: string, max: number): Buffer => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error('it is not a regular file');
    if (info.size > max) throw new Error(`it is larger than ${max} bytes`);
    const data = Buffer.alloc(info.size);
    let read = 0;
    while (read < data.length) {
      const got = readSync(fd, data, read, data.length - read, read);
      if (got === 0) throw new Error('it ended before its size');
      read += got;
    }
    return data;
  } finally {
    closeSync(fd);
  }
};
