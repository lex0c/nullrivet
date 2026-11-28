import { expect } from 'bun:test';
import { PLAN_ADDRESS } from '../../../src/sandbox/vm/init.ts';

export interface Member {
  offset: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  rdev: [number, number];
  name: string;
  data: Buffer;
}

// Reads an archive back, member by member, as the kernel's unpacker walks it.
export const cpioMembers = (archive: Buffer): Member[] => {
  const read: Member[] = [];
  let at = 0;
  for (;;) {
    expect(archive.subarray(at, at + 6).toString('ascii')).toBe('070701');
    const field = (index: number) =>
      Number.parseInt(archive.subarray(at + 6 + index * 8, at + 14 + index * 8).toString(), 16);
    const nameSize = field(11);
    const dataSize = field(6);
    const nameStart = at + 110;
    const name = archive.subarray(nameStart, nameStart + nameSize - 1).toString('utf8');
    expect(archive[nameStart + nameSize - 1]).toBe(0);
    const dataStart = nameStart + nameSize + ((4 - ((110 + nameSize) % 4)) % 4);
    expect(dataStart % 4).toBe(0);
    read.push({
      offset: at,
      ino: field(0),
      mode: field(1),
      uid: field(2),
      gid: field(3),
      mtime: field(5),
      rdev: [field(9), field(10)],
      name,
      data: archive.subarray(dataStart, dataStart + dataSize),
    });
    at = dataStart + dataSize + ((4 - (dataSize % 4)) % 4);
    if (name === 'TRAILER!!!') break;
  }
  expect(at).toBe(archive.length);
  return read;
};

// The program's segments, as the kernel maps them.
export const elfSegments = (elf: Buffer) => {
  expect(elf.subarray(0, 4).toString('latin1')).toBe('\x7fELF');
  expect([elf[4], elf[5], elf.readUInt16LE(16), elf.readUInt16LE(18)]).toEqual([2, 1, 2, 62]);
  const count = elf.readUInt16LE(56);
  return Array.from({ length: count }, (_, index) => {
    const at = elf.readUInt32LE(32) + index * 56;
    return {
      type: elf.readUInt32LE(at),
      flags: elf.readUInt32LE(at + 4),
      offset: Number(elf.readBigUInt64LE(at + 8)),
      address: Number(elf.readBigUInt64LE(at + 16)),
      size: Number(elf.readBigUInt64LE(at + 32)),
      memory: Number(elf.readBigUInt64LE(at + 40)),
    };
  });
};

// Reads the plan back from the program, following its pointers as the init does.
export const initPlanOf = (elf: Buffer) => {
  const data = elfSegments(elf).find((segment) => segment.address === PLAN_ADDRESS);
  if (data === undefined) throw new Error('no plan');
  const at = (address: bigint) => data.offset + Number(address) - PLAN_ADDRESS;
  const word = (address: bigint) => elf.readBigUInt64LE(at(address));
  const string = (address: bigint) => {
    const start = at(address);
    return elf.toString('utf8', start, elf.indexOf(0, start));
  };
  const table = (address: bigint, width: number) => {
    const rows: bigint[][] = [];
    for (let row = address; word(row) !== 0n; row += BigInt(width * 8)) {
      rows.push(Array.from({ length: width }, (_, index) => word(row + BigInt(index * 8))));
    }
    return rows;
  };
  const field = (index: number) => word(BigInt(PLAN_ADDRESS + index * 8));
  const mounts = (address: bigint) =>
    table(address, 5).map(([source, target, type, flags, options]) => ({
      source: string(source as bigint),
      target: string(target as bigint),
      type: string(type as bigint),
      flags: Number(flags),
      data: string(options as bigint),
    }));
  const strings = (address: bigint) => table(address, 1).map(([text]) => string(text as bigint));
  return {
    early: mounts(field(0)),
    directories: table(field(1), 2).map(([path, mode]) => ({
      path: string(path as bigint),
      mode: Number(mode),
    })),
    devices: mounts(field(2)),
    links: table(field(3), 2).map(([target, path]) => ({
      target: string(target as bigint),
      path: string(path as bigint),
    })),
    modules: table(field(4), 2).map(([path, flags]) => ({
      path: string(path as bigint),
      flags: Number(flags),
    })),
    mounts: mounts(field(5)),
    checks: table(field(6), 3).map(([path, content, length]) => ({
      path: string(path as bigint),
      content: elf.subarray(at(content as bigint), at(content as bigint) + Number(length)),
    })),
    netlink: table(field(7), 2).map(([message, length]) =>
      elf.subarray(at(message as bigint), at(message as bigint) + Number(length)),
    ),
    ports: { in: string(field(8)), out: string(field(9)) },
    worker: {
      path: string(field(10)),
      argv: strings(field(11)),
      env: Object.fromEntries(strings(field(12)).map((entry) => entry.split(/=(.*)/s).slice(0, 2))),
      cwd: string(field(13)),
      uid: Number(field(14)),
      gid: Number(field(15)),
    },
  };
};
