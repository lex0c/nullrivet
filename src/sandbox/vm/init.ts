import { INIT_CODE } from './init-code.ts';

// The guest's init as an executable: a static x86-64 ELF of two segments, the fixed code of
// init.s, readable and executable, and the session's plan at PLAN_ADDRESS, read-only, which the code
// reads by absolute address. The plan's tables hold absolute pointers into the plan itself.

export const PLAN_ADDRESS = 0x600000;
const CODE_ADDRESS = 0x400000;
const PAGE = 0x1000;
const ELF_HEADER_BYTES = 64;
const PROGRAM_HEADER_BYTES = 56;
// The two segments, and a stack that is not executable.
const PROGRAM_HEADERS = 3;
const HEADERS_BYTES = ELF_HEADER_BYTES + PROGRAM_HEADERS * PROGRAM_HEADER_BYTES;
const PT_LOAD = 1;
const PT_GNU_STACK = 0x6474e551;
const PF_X = 1;
const PF_W = 2;
const PF_R = 4;

// The flags of mount(2) the plan uses.
export const MS_RDONLY = 0x1;
export const MS_NOSUID = 0x2;
export const MS_NODEV = 0x4;
export const MS_NOEXEC = 0x8;
// finit_module(2): the module is compressed, for the kernel to decompress.
export const MODULE_INIT_COMPRESSED_FILE = 0x4;

export interface InitMount {
  source: string;
  target: string;
  type: string;
  flags: number;
  data: string;
}

export interface InitPlan {
  early: InitMount[];
  directories: { path: string; mode: number }[];
  devices: InitMount[];
  links: { target: string; path: string }[];
  modules: { path: string; flags: number }[];
  mounts: InitMount[];
  checks: { path: string; content: Buffer }[];
  netlink: Buffer[];
  ports: { in: string; out: string };
  worker: {
    path: string;
    argv: string[];
    env: Record<string, string>;
    cwd: string;
    uid: number;
    gid: number;
  };
}

// The plan's bytes, laid out from PLAN_ADDRESS, each piece aligned to eight bytes.
class Plan {
  private readonly pieces: Buffer[] = [];
  private size: number;

  constructor(headerBytes: number) {
    this.size = headerBytes;
  }

  place(bytes: Buffer): bigint {
    const address = BigInt(PLAN_ADDRESS + this.size);
    const padded = Buffer.concat([bytes, Buffer.alloc((8 - (bytes.length % 8)) % 8)]);
    this.pieces.push(padded);
    this.size += padded.length;
    return address;
  }

  string(text: string): bigint {
    if (text.includes('\0'))
      throw new Error(`the guest's init cannot be given ${JSON.stringify(text)}`);
    return this.place(Buffer.from(`${text}\0`, 'utf8'));
  }

  words(values: readonly bigint[]): bigint {
    const bytes = Buffer.alloc(values.length * 8);
    for (const [index, value] of values.entries()) bytes.writeBigUInt64LE(value, index * 8);
    return this.place(bytes);
  }

  body(): Buffer {
    return Buffer.concat(this.pieces);
  }
}

const id = (value: number): bigint => {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** 32 - 1) {
    throw new Error(`the guest's worker cannot run as ${value}`);
  }
  return BigInt(value);
};

const planBytes = (plan: InitPlan): Buffer => {
  const header = 16;
  const writer = new Plan(header * 8);
  const mounts = (list: readonly InitMount[]): bigint =>
    writer.words([
      ...list.flatMap((mount) => [
        writer.string(mount.source),
        writer.string(mount.target),
        writer.string(mount.type),
        BigInt(mount.flags),
        writer.string(mount.data),
      ]),
      0n,
      0n,
      0n,
      0n,
      0n,
    ]);
  const strings = (list: readonly string[]): bigint =>
    writer.words([...list.map((text) => writer.string(text)), 0n]);
  const fields = [
    mounts(plan.early),
    writer.words([
      ...plan.directories.flatMap((directory) => [
        writer.string(directory.path),
        BigInt(directory.mode),
      ]),
      0n,
      0n,
    ]),
    mounts(plan.devices),
    writer.words([
      ...plan.links.flatMap((link) => [writer.string(link.target), writer.string(link.path)]),
      0n,
      0n,
    ]),
    writer.words([
      ...plan.modules.flatMap((module) => [writer.string(module.path), BigInt(module.flags)]),
      0n,
      0n,
    ]),
    mounts(plan.mounts),
    writer.words([
      ...plan.checks.flatMap((check) => [
        writer.string(check.path),
        writer.place(check.content),
        BigInt(check.content.length),
      ]),
      0n,
      0n,
      0n,
    ]),
    writer.words([
      ...plan.netlink.flatMap((message) => [writer.place(message), BigInt(message.length)]),
      0n,
      0n,
    ]),
    writer.string(plan.ports.in),
    writer.string(plan.ports.out),
    writer.string(plan.worker.path),
    strings(plan.worker.argv),
    strings(Object.entries(plan.worker.env).map(([key, value]) => `${key}=${value}`)),
    writer.string(plan.worker.cwd),
    id(plan.worker.uid),
    id(plan.worker.gid),
  ];
  const head = Buffer.alloc(header * 8);
  for (const [index, value] of fields.entries()) head.writeBigUInt64LE(value, index * 8);
  return Buffer.concat([head, writer.body()]);
};

const programHeader = (
  type: number,
  flags: number,
  offset: number,
  address: number,
  size: number,
): Buffer => {
  const bytes = Buffer.alloc(PROGRAM_HEADER_BYTES);
  bytes.writeUInt32LE(type, 0);
  bytes.writeUInt32LE(flags, 4);
  bytes.writeBigUInt64LE(BigInt(offset), 8);
  bytes.writeBigUInt64LE(BigInt(address), 16);
  bytes.writeBigUInt64LE(BigInt(address), 24);
  bytes.writeBigUInt64LE(BigInt(size), 32);
  bytes.writeBigUInt64LE(BigInt(size), 40);
  bytes.writeBigUInt64LE(BigInt(type === PT_LOAD ? PAGE : 16), 48);
  return bytes;
};

// The init for `plan`, as the guest runs it.
export const initProgram = (plan: InitPlan, code: Buffer = INIT_CODE): Buffer => {
  const data = planBytes(plan);
  const codeEnd = HEADERS_BYTES + code.length;
  const dataOffset = Math.ceil(codeEnd / PAGE) * PAGE;
  const elf = Buffer.alloc(ELF_HEADER_BYTES);
  elf.write('\x7fELF', 0, 'latin1');
  // 64 bits, little-endian, version 1, the System V ABI.
  elf.writeUInt8(2, 4);
  elf.writeUInt8(1, 5);
  elf.writeUInt8(1, 6);
  // An executable for x86-64.
  elf.writeUInt16LE(2, 16);
  elf.writeUInt16LE(62, 18);
  elf.writeUInt32LE(1, 20);
  elf.writeBigUInt64LE(BigInt(CODE_ADDRESS + HEADERS_BYTES), 24);
  elf.writeBigUInt64LE(BigInt(ELF_HEADER_BYTES), 32);
  elf.writeUInt16LE(ELF_HEADER_BYTES, 52);
  elf.writeUInt16LE(PROGRAM_HEADER_BYTES, 54);
  elf.writeUInt16LE(PROGRAM_HEADERS, 56);
  elf.writeUInt16LE(64, 58);
  return Buffer.concat([
    elf,
    programHeader(PT_LOAD, PF_R | PF_X, 0, CODE_ADDRESS, codeEnd),
    programHeader(PT_LOAD, PF_R, dataOffset, PLAN_ADDRESS, data.length),
    programHeader(PT_GNU_STACK, PF_R | PF_W, 0, 0, 0),
    code,
    Buffer.alloc(dataOffset - codeEnd),
    data,
  ]);
};
