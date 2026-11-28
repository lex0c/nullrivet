import { closeSync, constants, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { availableParallelism, release, userInfo } from 'node:os';
import { join } from 'node:path';
import { errorMessage } from '../../errors.ts';
import { identityFiles, type LaunchOptions, sandboxEnv, trustedExecutable } from '../bwrap.ts';
import type { Network } from '../network/ruleset.ts';
import { SANDBOX_WORKER_DIR, sandboxedWorker } from '../worker-command.ts';
import { guestBoot } from './guest.ts';
import {
  type GuestKernel,
  type GuestModule,
  guestModules,
  hostKernel,
  operatorKernel,
} from './kernel.ts';
import { guestManifest, hostEntries } from './manifest.ts';
import { type GuestNetwork, guestNetwork, KERNEL_COMMAND_LINE, qemuArgs } from './qemu.ts';

// What a security session needs of the host to run its commands in a virtual machine, and the
// files and the command line of that machine. QEMU runs inside the profile's sandbox, in the
// worker's place: the sandbox binds it /dev/kvm, the kernel and the initramfs besides what it
// binds the worker, which the guest reaches through QEMU's exports.

// QEMU sets the guest up from inside the sandbox, with the user's access: like Bubblewrap, it is
// taken from system directories only, never from PATH.
export const QEMU_LOCATIONS = [
  '/usr/bin/qemu-system-x86_64',
  '/usr/local/bin/qemu-system-x86_64',
  '/bin/qemu-system-x86_64',
  '/run/current-system/sw/bin/qemu-system-x86_64',
];

// Where the sandbox binds the guest's kernel and initramfs, read-only.
export const GUEST_FILES_DIR = '/.nullrivet-vm';

// QEMU's own memory beside the guest's, measured at about 150 MiB, with room: the sandbox's limit
// holds both.
const QEMU_OVERHEAD_MIB = 512;
const MIN_GUEST_MIB = 256;
const MAX_GUEST_MIB = 4096;
const MAX_GUEST_CPUS = 4;

export interface GuestHost {
  qemu: string;
  kernel: GuestKernel;
  modules: GuestModule[];
}

// What the host must have for a guest, or the first thing it lacks, with what to do about it.
export const guestHost = (options: {
  kernel?: string;
  arch?: string;
  kvm?: string;
  qemuLocations?: readonly string[];
}): GuestHost | { error: string } => {
  const arch = options.arch ?? process.arch;
  if (arch !== 'x64') return { error: 'the virtual machine runs on x86-64 hosts only' };
  const kvm = options.kvm ?? '/dev/kvm';
  try {
    closeSync(openSync(kvm, constants.O_RDWR));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      error:
        code === 'ENOENT'
          ? `this host has no ${kvm}: the virtual machine needs KVM, with the processor's virtualization on`
          : code === 'EACCES'
            ? `the user cannot open ${kvm}: it needs read and write access, usually by the group kvm`
            : `${kvm} cannot be opened: ${errorMessage(error)}`,
    };
  }
  const locations = options.qemuLocations ?? QEMU_LOCATIONS;
  const qemu = locations.map(trustedExecutable).find((path) => path !== null);
  if (qemu === undefined || qemu === null) {
    return {
      error: `the virtual machine needs QEMU, in one of ${locations.join(', ')}, owned by root and writable by no one else`,
    };
  }
  const kernel =
    options.kernel === undefined ? hostKernel(release()) : operatorKernel(options.kernel);
  if ('error' in kernel) return kernel;
  const modules = guestModules(kernel.release);
  if ('error' in modules) return modules;
  return { qemu, kernel, modules };
};

// The guest's memory and processors under the sandbox's memory limit.
export const guestResources = (
  memoryBytes: number,
  cpus: number = availableParallelism(),
): { memoryMiB: number; cpus: number } => ({
  memoryMiB: Math.max(
    MIN_GUEST_MIB,
    Math.min(MAX_GUEST_MIB, Math.floor(memoryBytes / 1024 / 1024) - QEMU_OVERHEAD_MIB),
  ),
  cpus: Math.max(1, Math.min(MAX_GUEST_CPUS, cpus)),
});

export interface GuestLaunch {
  // What the sandbox runs in the worker's place, binds for it, and gives it of the host's devices.
  command: string[];
  binds: { source: string; target: string }[];
  devices: string[];
  network: GuestNetwork;
  // For the evidence: what the guest boots, by its hashes.
  record: Record<string, unknown>;
}

// Writes `bytes` to a new file only the user can read.
const writePrivate = (path: string, bytes: Uint8Array): void => {
  writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
};

// The guest of a session whose sandbox is launched with `launch`, its files written in the
// session's `directory`, its networks away from the scope's `networks`.
export const guestLaunch = (
  host: GuestHost,
  launch: LaunchOptions,
  options: {
    directory: string;
    networks: readonly Network[];
    memoryBytes: number;
    hashOutputs: boolean;
  },
): GuestLaunch | { error: string } => {
  const network = guestNetwork(options.networks);
  if ('error' in network) return network;
  const entries = hostEntries();
  if ('error' in entries) return entries;
  const manifest = guestManifest(
    {
      project: launch.root,
      home: launch.home,
      readOnlyDirs: launch.readOnlyDirs,
      workerDir: SANDBOX_WORKER_DIR,
      identity: identityFiles(launch.home),
    },
    entries,
  );
  if ('error' in manifest) return manifest;
  const command = sandboxedWorker(launch.tools, launch.jobs, options.hashOutputs).command;
  const user = userInfo();
  let boot: ReturnType<typeof guestBoot>;
  try {
    boot = guestBoot(
      manifest,
      host.modules,
      {
        path: command[0] as string,
        argv: [...command],
        env: sandboxEnv(launch.hostEnv, launch.home),
        cwd: launch.cwd,
        uid: user.uid,
        gid: user.gid,
      },
      network,
    );
  } catch (error) {
    return { error: `the guest's initramfs cannot be made: ${errorMessage(error)}` };
  }
  const dir = join(options.directory, 'vm');
  const kernel = join(dir, 'kernel');
  const initrd = join(dir, 'initrd');
  try {
    mkdirSync(dir, { mode: 0o700 });
    writePrivate(kernel, host.kernel.image);
    writePrivate(initrd, boot.initramfs);
  } catch (error) {
    return { error: `the guest's files cannot be written: ${errorMessage(error)}` };
  }
  const resources = guestResources(options.memoryBytes);
  const args = qemuArgs({
    kernel: `${GUEST_FILES_DIR}/kernel`,
    initrd: `${GUEST_FILES_DIR}/initrd`,
    ...resources,
    exports: manifest.exports,
    network,
  });
  return {
    command: [host.qemu, ...args],
    binds: [
      { source: kernel, target: `${GUEST_FILES_DIR}/kernel` },
      { source: initrd, target: `${GUEST_FILES_DIR}/initrd` },
    ],
    devices: ['/dev/kvm'],
    network,
    record: {
      qemu: host.qemu,
      machine: 'q35',
      kernelSource: host.kernel.source,
      kernel: { path: host.kernel.path, release: host.kernel.release, sha256: host.kernel.sha256 },
      modules: host.modules.map(({ name, sha256 }) => ({ name, sha256 })),
      initramfsSha256: boot.sha256,
      commandLine: KERNEL_COMMAND_LINE,
      memoryMiB: resources.memoryMiB,
      cpus: resources.cpus,
      network: { ipv4: network.network, ipv6: network.network6 },
    },
  };
};
