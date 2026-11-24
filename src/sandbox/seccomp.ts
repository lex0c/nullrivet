// The seccomp program bubblewrap installs before the worker starts, inherited by every command.
// It denies with EPERM:
// - the key management calls, because the kernel keyrings are shared with the host and can hold
//   credentials such as Kerberos tickets;
// - socket(AF_UNIX), because a read-only bind does not stop a connection to a host socket inside
//   the project, including one created after the sandbox started. socketpair stays allowed: it
//   only makes a pair already connected to itself. Abstract sockets belong to the network
//   namespace, which the sandbox does not share.
// - the io_uring calls, because an io_uring operation creates a socket without the socket call,
//   which would make the AF_UNIX rule above ineffective. Programs that use io_uring fall back to
//   the ordinary calls when it cannot be set up.
// On x86_64 the x32 ABI shares the architecture value and marks its calls with a bit of the
// number, so a call with that bit is denied outright rather than matched by number. A call made
// through another architecture's ABI, such as i386 through int 0x80, gets ENOSYS.

export type SyscallArch = 'x64' | 'arm64';

interface ArchTable {
  audit: number;
  x32: boolean;
  socket: number;
  keyctl: number;
  addKey: number;
  requestKey: number;
}

const ARCHES: Record<SyscallArch, ArchTable> = {
  x64: { audit: 0xc000003e, x32: true, socket: 41, keyctl: 250, addKey: 248, requestKey: 249 },
  arm64: { audit: 0xc00000b7, x32: false, socket: 198, keyctl: 219, addKey: 217, requestKey: 218 },
};

// The architecture the sandbox supports on this host, or null.
export const sandboxArch = (arch: string = process.arch): SyscallArch | null =>
  arch === 'x64' || arch === 'arm64' ? arch : null;

const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_JSET_K = 0x45;
const BPF_RET_K = 0x06;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const EPERM = 1;
const ENOSYS = 38;
const X32_SYSCALL_BIT = 0x40000000;
// Added after the system call numbers were unified, so the same on x86_64 and arm64.
const IO_URING_SETUP = 425;
const IO_URING_ENTER = 426;
const IO_URING_REGISTER = 427;
const AF_UNIX = 1;
// Offsets in struct seccomp_data: nr, arch, then the arguments from byte 16. The low half of a
// 64-bit argument comes first on these little-endian architectures.
const NR = 0;
const ARCH = 4;
const ARG0 = 16;

type Label = 'allow' | 'deny' | 'foreign';
type Instruction =
  | { op: 'load'; offset: number }
  | { op: 'jeq' | 'jset'; k: number; match: Label | 'next'; miss: Label | 'next' }
  | { op: 'ret'; label: Label; k: number };

export const seccompProgram = (arch: SyscallArch): Uint8Array => {
  const table = ARCHES[arch];
  const program: Instruction[] = [
    { op: 'load', offset: ARCH },
    { op: 'jeq', k: table.audit, match: 'next', miss: 'foreign' },
    { op: 'load', offset: NR },
    ...(table.x32
      ? [{ op: 'jset' as const, k: X32_SYSCALL_BIT, match: 'deny' as const, miss: 'next' as const }]
      : []),
    { op: 'jeq', k: table.keyctl, match: 'deny', miss: 'next' },
    { op: 'jeq', k: table.addKey, match: 'deny', miss: 'next' },
    { op: 'jeq', k: table.requestKey, match: 'deny', miss: 'next' },
    { op: 'jeq', k: IO_URING_SETUP, match: 'deny', miss: 'next' },
    { op: 'jeq', k: IO_URING_ENTER, match: 'deny', miss: 'next' },
    { op: 'jeq', k: IO_URING_REGISTER, match: 'deny', miss: 'next' },
    { op: 'jeq', k: table.socket, match: 'next', miss: 'allow' },
    { op: 'load', offset: ARG0 },
    { op: 'jeq', k: AF_UNIX, match: 'deny', miss: 'allow' },
    { op: 'ret', label: 'allow', k: SECCOMP_RET_ALLOW },
    { op: 'ret', label: 'deny', k: SECCOMP_RET_ERRNO | EPERM },
    { op: 'ret', label: 'foreign', k: SECCOMP_RET_ERRNO | ENOSYS },
  ];
  const at = (label: Label): number =>
    program.findIndex((instruction) => instruction.op === 'ret' && instruction.label === label);
  const offset = (index: number, target: Label | 'next'): number =>
    target === 'next' ? 0 : at(target) - index - 1;
  const bytes = Buffer.alloc(program.length * 8);
  program.forEach((instruction, index) => {
    const base = index * 8;
    switch (instruction.op) {
      case 'load':
        bytes.writeUInt16LE(BPF_LD_W_ABS, base);
        bytes.writeUInt32LE(instruction.offset, base + 4);
        return;
      case 'jeq':
      case 'jset':
        bytes.writeUInt16LE(instruction.op === 'jeq' ? BPF_JEQ_K : BPF_JSET_K, base);
        bytes.writeUInt8(offset(index, instruction.match), base + 2);
        bytes.writeUInt8(offset(index, instruction.miss), base + 3);
        bytes.writeUInt32LE(instruction.k >>> 0, base + 4);
        return;
      case 'ret':
        bytes.writeUInt16LE(BPF_RET_K, base);
        bytes.writeUInt32LE(instruction.k >>> 0, base + 4);
        return;
    }
  });
  return bytes;
};
