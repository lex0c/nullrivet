import { createHash } from 'node:crypto';
import { type CpioEntry, cpioArchive } from './cpio.ts';
import {
  type InitMount,
  type InitPlan,
  initProgram,
  MODULE_INIT_COMPRESSED_FILE,
  MS_NODEV,
  MS_NOEXEC,
  MS_NOSUID,
  MS_RDONLY,
} from './init.ts';
import type { GuestModule } from './kernel.ts';
import type { GuestExport, GuestManifest } from './manifest.ts';
import { addAddress, addDefaultRoute, linkUp } from './netlink.ts';
import { type GuestNetwork, PROTOCOL_PORTS } from './qemu.ts';

// The guest's initramfs: its init, with the session's plan, the kernel's modules, and the root the
// manifest describes. The kernel's virtual filesystems are mounted without set-user-ID files,
// devices or programs; the exports without set-user-ID files or devices, since /usr holds programs
// set-user-ID root that the guest's kernel would otherwise honour. /dev holds what Bubblewrap's
// gives the profiles: pseudo-terminals of the guest's own, shared memory, and the links to a
// process's descriptors.

const OPTIONS_9P = 'trans=virtio,version=9p2000.L,msize=524288,cache=none';
// The protocol's device is the guest's first virtio device; the network device is its only one.
const PORTS = { in: '/dev/vport0p1', out: '/dev/vport0p2' };
const PORT_NAMES = {
  in: '/sys/class/virtio-ports/vport0p1/name',
  out: '/sys/class/virtio-ports/vport0p2/name',
};
const LOOPBACK_INDEX = 1;
const NETWORK_INDEX = 2;

export interface GuestWorker {
  path: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  uid: number;
  gid: number;
}

export interface GuestBoot {
  initramfs: Buffer;
  sha256: string;
}

const exportMount = (entry: GuestExport): InitMount => ({
  source: entry.tag,
  target: entry.path,
  type: '9p',
  flags: MS_NOSUID | MS_NODEV | (entry.readOnly ? MS_RDONLY : 0),
  data: OPTIONS_9P,
});

export const guestPlan = (
  manifest: GuestManifest,
  modules: readonly GuestModule[],
  worker: GuestWorker,
  net: GuestNetwork,
): InitPlan => {
  return {
    early: [
      {
        source: 'proc',
        target: '/proc',
        type: 'proc',
        flags: MS_NOSUID | MS_NODEV | MS_NOEXEC,
        data: '',
      },
      {
        source: 'devtmpfs',
        target: '/dev',
        type: 'devtmpfs',
        flags: MS_NOSUID | MS_NOEXEC,
        data: '',
      },
      {
        source: 'sysfs',
        target: '/sys',
        type: 'sysfs',
        flags: MS_NOSUID | MS_NODEV | MS_NOEXEC,
        data: '',
      },
    ],
    directories: [
      { path: '/dev/pts', mode: 0o755 },
      { path: '/dev/shm', mode: 0o755 },
    ],
    devices: [
      {
        source: 'devpts',
        target: '/dev/pts',
        type: 'devpts',
        flags: MS_NOSUID | MS_NOEXEC,
        data: 'newinstance,ptmxmode=0666,mode=0620',
      },
      {
        source: 'shm',
        target: '/dev/shm',
        type: 'tmpfs',
        flags: MS_NOSUID | MS_NODEV,
        data: 'mode=1777',
      },
    ],
    links: [
      { target: '/proc/self/fd', path: '/dev/fd' },
      { target: '/proc/self/fd/0', path: '/dev/stdin' },
      { target: '/proc/self/fd/1', path: '/dev/stdout' },
      { target: '/proc/self/fd/2', path: '/dev/stderr' },
    ],
    modules: modules.map((module) => ({
      path: modulePath(module),
      flags: module.compressed ? MODULE_INIT_COMPRESSED_FILE : 0,
    })),
    mounts: manifest.exports.map(exportMount),
    checks: [
      { path: PORT_NAMES.in, content: Buffer.from(`${PROTOCOL_PORTS.in}\n`) },
      { path: PORT_NAMES.out, content: Buffer.from(`${PROTOCOL_PORTS.out}\n`) },
      { path: '/sys/class/net/eth0/ifindex', content: Buffer.from(`${NETWORK_INDEX}\n`) },
    ],
    netlink: [
      linkUp(LOOPBACK_INDEX, 1),
      linkUp(NETWORK_INDEX, 2),
      addAddress(NETWORK_INDEX, net.address, net.prefix, 3),
      addDefaultRoute(NETWORK_INDEX, net.gateway, 4),
      addAddress(NETWORK_INDEX, net.address6, net.prefix6, 5),
      addDefaultRoute(NETWORK_INDEX, net.gateway6, 6),
    ],
    ports: PORTS,
    worker,
  };
};

const modulePath = (module: GuestModule): string =>
  `/modules/${module.name}.ko${module.compressed ? '.xz' : ''}`;

export const guestBoot = (
  manifest: GuestManifest,
  modules: readonly GuestModule[],
  worker: GuestWorker,
  network: GuestNetwork,
): GuestBoot => {
  const entries: CpioEntry[] = [
    ...manifest.entries,
    { kind: 'directory', path: 'modules', mode: 0o755 },
    ...modules.map(
      (module): CpioEntry => ({
        kind: 'file',
        path: modulePath(module).slice(1),
        mode: 0o644,
        data: module.data,
      }),
    ),
    {
      kind: 'file',
      path: 'init',
      mode: 0o755,
      data: initProgram(guestPlan(manifest, modules, worker, network)),
    },
  ];
  const initramfs = cpioArchive(entries);
  return { initramfs, sha256: createHash('sha256').update(initramfs).digest('hex') };
};
