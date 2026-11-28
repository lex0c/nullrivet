import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { type CpioEntry, cpioArchive } from '../../../src/sandbox/vm/cpio.ts';
import { cpioMembers } from './readers.ts';

const SAMPLE: CpioEntry[] = [
  { kind: 'directory', path: 'dev', mode: 0o755 },
  { kind: 'char', path: 'dev/console', mode: 0o600, major: 5, minor: 1 },
  { kind: 'directory', path: 'etc', mode: 0o755 },
  { kind: 'file', path: 'etc/hosts', mode: 0o644, data: Buffer.from('127.0.0.1 localhost\n') },
  { kind: 'link', path: 'lib', target: 'usr/lib' },
  { kind: 'file', path: 'init', mode: 0o755, data: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]) },
];

describe('the initramfs archive', () => {
  test('holds each entry as the kernel reads it, aligned, owned by root, with no time', () => {
    const read = cpioMembers(cpioArchive(SAMPLE));
    expect(read.map(({ name }) => name)).toEqual([
      'dev',
      'dev/console',
      'etc',
      'etc/hosts',
      'lib',
      'init',
      'TRAILER!!!',
    ]);
    for (const entry of read) {
      expect(entry.offset % 4).toBe(0);
      expect([entry.uid, entry.gid, entry.mtime]).toEqual([0, 0, 0]);
    }
    expect(read[0]?.mode).toBe(0o040755);
    expect(read[1]).toMatchObject({ mode: 0o020600, rdev: [5, 1] });
    expect(read[3]?.mode).toBe(0o100644);
    expect(read[3]?.data.toString()).toBe('127.0.0.1 localhost\n');
    expect(read[4]).toMatchObject({ mode: 0o120777 });
    expect(read[4]?.data.toString()).toBe('usr/lib');
    expect(read[5]?.data).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]));
    expect(new Set(read.slice(0, -1).map(({ ino }) => ino)).size).toBe(SAMPLE.length);
  });

  test('writes the header of the newc format', () => {
    const archive = cpioArchive([{ kind: 'directory', path: 'proc', mode: 0o555 }]);
    expect(archive.subarray(0, 110).toString('ascii')).toBe(
      `070701${['1', '416d', '0', '0', '1', '0', '0', '0', '0', '0', '0', '5', '0']
        .map((hex) => hex.padStart(8, '0'))
        .join('')}`,
    );
    expect(archive.subarray(110, 116)).toEqual(Buffer.from('proc\0\0'));
  });

  test('holds the root itself as its first entry, with the mode given', () => {
    const read = cpioMembers(
      cpioArchive([
        { kind: 'directory', path: '.', mode: 0o755 },
        { kind: 'directory', path: 'etc', mode: 0o755 },
      ]),
    );
    expect(read[0]).toMatchObject({ name: '.', mode: 0o040755 });
    expect(() =>
      cpioArchive([
        { kind: 'directory', path: 'etc', mode: 0o755 },
        { kind: 'directory', path: '.', mode: 0o755 },
      ]),
    ).toThrow('the initramfs cannot hold the path "."');
    expect(() =>
      cpioArchive([{ kind: 'file', path: '.', mode: 0o644, data: Buffer.alloc(0) }]),
    ).toThrow('the initramfs cannot hold the path "."');
  });

  test('gives the same archive for the same contents', () => {
    expect(cpioArchive(SAMPLE).equals(cpioArchive(SAMPLE))).toBe(true);
  });

  test('refuses an entry the kernel would unpack elsewhere, or not at all', () => {
    const refused: [CpioEntry[], string][] = [
      [
        [{ kind: 'directory', path: '/etc', mode: 0o755 }],
        'the initramfs cannot hold the path "/etc"',
      ],
      [
        [{ kind: 'directory', path: 'a/../b', mode: 0o755 }],
        'the initramfs cannot hold the path "a/../b"',
      ],
      [
        [{ kind: 'directory', path: 'a//b', mode: 0o755 }],
        'the initramfs cannot hold the path "a//b"',
      ],
      [[{ kind: 'directory', path: '', mode: 0o755 }], 'the initramfs cannot hold the path ""'],
      [
        [
          { kind: 'directory', path: 'etc', mode: 0o755 },
          { kind: 'directory', path: 'etc', mode: 0o755 },
        ],
        'the initramfs holds etc twice',
      ],
      [
        [{ kind: 'file', path: 'etc/hosts', mode: 0o644, data: Buffer.alloc(0) }],
        'the initramfs holds etc/hosts before its directory etc',
      ],
      [
        [
          { kind: 'link', path: 'etc', target: '/tmp' },
          { kind: 'file', path: 'etc/hosts', mode: 0o644, data: Buffer.alloc(0) },
        ],
        'the initramfs holds etc/hosts before its directory etc',
      ],
      [
        [{ kind: 'file', path: 'init', mode: 0o4755, data: Buffer.alloc(0) }],
        'the initramfs cannot give init the mode 4755',
      ],
      [
        [{ kind: 'char', path: 'null', mode: 0o600, major: 0x1000, minor: 0 }],
        'the initramfs cannot hold the device 4096:0',
      ],
      [[{ kind: 'link', path: 'lib', target: '' }], 'the initramfs cannot hold a link to ""'],
    ];
    for (const [entries, message] of refused) {
      expect(() => cpioArchive(entries)).toThrow(message);
    }
  });

  const bsdcpio = spawnSync('bsdcpio', ['--version']).status === 0;
  test.if(bsdcpio)('reads back the same with another implementation', () => {
    const listed = spawnSync('bsdcpio', ['-itv'], { input: cpioArchive(SAMPLE) });
    expect(listed.status).toBe(0);
    const lines = listed.stdout.toString().trim().split('\n');
    // A link is listed as `name -> target`.
    expect(
      lines.map((line) =>
        line
          .replace(/ -> .*$/, '')
          .split(/\s+/)
          .at(-1),
      ),
    ).toEqual(['dev', 'dev/console', 'etc', 'etc/hosts', 'lib', 'init']);
    expect(lines.find((line) => line.includes(' -> '))).toEndWith('lib -> usr/lib');
  });
});
