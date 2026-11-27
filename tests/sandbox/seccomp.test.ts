import { describe, expect, test } from 'bun:test';
import { type SyscallArch, seccompProgram } from '../../src/sandbox/seccomp.ts';

// The program as the kernel runs it: a classic BPF interpreter of the instructions it uses, over
// a struct seccomp_data of the call.
const run = (program: Uint8Array, data: { nr: number; arch: number; args: number[] }): number => {
  const call = new DataView(new ArrayBuffer(64));
  call.setUint32(0, data.nr, true);
  call.setUint32(4, data.arch, true);
  data.args.forEach((arg, index) => {
    call.setUint32(16 + index * 8, arg >>> 0, true);
  });
  const code = new DataView(program.buffer, program.byteOffset, program.byteLength);
  let a = 0;
  for (let pc = 0; pc * 8 < program.byteLength; ) {
    const op = code.getUint16(pc * 8, true);
    const jt = code.getUint8(pc * 8 + 2);
    const jf = code.getUint8(pc * 8 + 3);
    const k = code.getUint32(pc * 8 + 4, true);
    switch (op) {
      case 0x20:
        a = call.getUint32(k, true);
        pc += 1;
        break;
      case 0x54:
        a = (a & k) >>> 0;
        pc += 1;
        break;
      case 0x15:
        pc += 1 + (a === k ? jt : jf);
        break;
      case 0x45:
        pc += 1 + ((a & k) !== 0 ? jt : jf);
        break;
      case 0x06:
        return k;
      default:
        throw new Error(`instruction ${op} at ${pc} is not one the program uses`);
    }
  }
  throw new Error('the program ran past its end');
};

const ALLOW = 0x7fff0000;
const EPERM = 0x00050000 | 1;
const ENOSYS = 0x00050000 | 38;

const ARCHES: Record<SyscallArch, { audit: number; socket: number; keyctl: number }> = {
  x64: { audit: 0xc000003e, socket: 41, keyctl: 250 },
  arm64: { audit: 0xc00000b7, socket: 198, keyctl: 219 },
};

const AF_UNIX = 1;
const AF_INET = 2;
const AF_INET6 = 10;
const AF_NETLINK = 16;
const AF_PACKET = 17;
const SOCK_STREAM = 1;
const SOCK_RAW = 3;
const SOCK_PACKET = 10;
const SOCK_NONBLOCK = 0x800;
const SOCK_CLOEXEC = 0x80000;

describe.each(Object.keys(ARCHES) as SyscallArch[])('the seccomp program on %s', (arch) => {
  const program = seccompProgram(arch);
  const { audit, socket, keyctl } = ARCHES[arch];
  const make = (...args: number[]) => run(program, { nr: socket, arch: audit, args });

  test('allows IPv4, IPv6 and netlink routing sockets, raw ones included', () => {
    expect(make(AF_INET, SOCK_STREAM, 0)).toBe(ALLOW);
    expect(make(AF_INET6, SOCK_STREAM | SOCK_CLOEXEC, 0)).toBe(ALLOW);
    // A raw socket needs CAP_NET_RAW, which the sandbox has not: the kernel refuses it.
    expect(make(AF_INET, SOCK_RAW, 1)).toBe(ALLOW);
    expect(make(AF_NETLINK, SOCK_RAW, 0)).toBe(ALLOW);
  });

  test('refuses the packet sockets IPv4 and IPv6 make with the type SOCK_PACKET, flags or not', () => {
    expect(make(AF_INET, SOCK_PACKET, 0x0300)).toBe(EPERM);
    expect(make(AF_INET6, SOCK_PACKET | SOCK_NONBLOCK | SOCK_CLOEXEC, 0x0300)).toBe(EPERM);
  });

  test('refuses every other family, and netlink but for routing', () => {
    expect(make(AF_UNIX, SOCK_STREAM, 0)).toBe(EPERM);
    expect(make(AF_PACKET, SOCK_RAW, 0x0300)).toBe(EPERM);
    expect(make(AF_NETLINK, SOCK_RAW, 15)).toBe(EPERM);
    expect(make(40, SOCK_STREAM, 0)).toBe(EPERM);
  });

  test('refuses the key calls, allows the rest, and the calls of another architecture', () => {
    expect(run(program, { nr: keyctl, arch: audit, args: [] })).toBe(EPERM);
    expect(run(program, { nr: 0, arch: audit, args: [] })).toBe(ALLOW);
    expect(run(program, { nr: socket, arch: 0x40000003, args: [AF_INET, SOCK_STREAM] })).toBe(
      ENOSYS,
    );
  });
});
