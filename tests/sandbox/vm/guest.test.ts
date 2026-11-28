import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { type GuestWorker, guestBoot, guestPlan } from '../../../src/sandbox/vm/guest.ts';
import {
  MODULE_INIT_COMPRESSED_FILE,
  MS_NODEV,
  MS_NOEXEC,
  MS_NOSUID,
  MS_RDONLY,
} from '../../../src/sandbox/vm/init.ts';
import type { GuestModule } from '../../../src/sandbox/vm/kernel.ts';
import { type GuestManifest, guestManifest } from '../../../src/sandbox/vm/manifest.ts';
import { addAddress, addDefaultRoute, linkUp } from '../../../src/sandbox/vm/netlink.ts';
import { type GuestNetwork, guestNetwork } from '../../../src/sandbox/vm/qemu.ts';
import { cpioMembers, initPlanOf } from './readers.ts';

const built = guestManifest(
  {
    project: '/home/ana/app',
    home: '/home/ana',
    readOnlyDirs: [],
    workerDir: '/.nullrivet-worker',
    identity: { passwd: 'ana:x:1000:1000::/home/ana:/bin/sh\n', group: 'ana:x:1000:\n' },
  },
  { root: [{ path: '/bin', kind: 'link', target: 'usr/bin' }], etc: [] },
);
if ('error' in built) throw new Error(built.error);
const MANIFEST: GuestManifest = built;
const chosen = guestNetwork([]);
if ('error' in chosen) throw new Error(chosen.error);
const NETWORK: GuestNetwork = chosen;

const MODULES: GuestModule[] = [
  {
    name: 'netfs',
    path: 'kernel/netfs.ko.zst',
    sha256: 'a',
    data: Buffer.from('netfs'),
    compressed: false,
  },
  {
    name: '9p',
    path: 'kernel/9p.ko.xz',
    sha256: 'b',
    data: Buffer.from('9p xz'),
    compressed: true,
  },
];
const WORKER: GuestWorker = {
  path: '/.nullrivet-worker/nullrivet',
  argv: ['/.nullrivet-worker/nullrivet', '--nullrivet-sandbox-worker'],
  env: { PATH: '/usr/bin' },
  cwd: '/home/ana/app',
  uid: 1000,
  gid: 1000,
};

describe("the guest's plan", () => {
  const plan = guestPlan(MANIFEST, MODULES, WORKER, NETWORK);

  test("mounts the kernel's filesystems, and /dev as the profiles have it", () => {
    expect(plan.early).toEqual([
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
    ]);
    expect(plan.devices.map(({ target, type }) => [target, type])).toEqual([
      ['/dev/pts', 'devpts'],
      ['/dev/shm', 'tmpfs'],
    ]);
    expect(plan.directories.map(({ path }) => path)).toEqual(['/dev/pts', '/dev/shm']);
    expect(plan.links).toEqual([
      { target: '/proc/self/fd', path: '/dev/fd' },
      { target: '/proc/self/fd/0', path: '/dev/stdin' },
      { target: '/proc/self/fd/1', path: '/dev/stdout' },
      { target: '/proc/self/fd/2', path: '/dev/stderr' },
    ]);
  });

  test('loads each module from the initramfs, a compressed one for the kernel to decompress', () => {
    expect(plan.modules).toEqual([
      { path: '/modules/netfs.ko', flags: 0 },
      { path: '/modules/9p.ko.xz', flags: MODULE_INIT_COMPRESSED_FILE },
    ]);
  });

  test('mounts each export without set-user-ID files or devices, read-only where it is', () => {
    expect(plan.mounts).toHaveLength(MANIFEST.exports.length);
    for (const [index, mount] of plan.mounts.entries()) {
      const entry = MANIFEST.exports[index];
      expect(mount).toMatchObject({ source: entry?.tag, target: entry?.path, type: '9p' });
      expect(mount.flags).toBe(MS_NOSUID | MS_NODEV | (entry?.readOnly ? MS_RDONLY : 0));
      expect(mount.data).toContain('trans=virtio');
      expect(mount.data).toContain('cache=none');
    }
  });

  test('waits for the ports by their names, and for the network device, before it uses them', () => {
    expect(plan.checks.map(({ path, content }) => [path, content.toString()])).toEqual([
      ['/sys/class/virtio-ports/vport0p1/name', 'nullrivet.in\n'],
      ['/sys/class/virtio-ports/vport0p2/name', 'nullrivet.out\n'],
      ['/sys/class/net/eth0/ifindex', '2\n'],
    ]);
    expect(plan.ports).toEqual({ in: '/dev/vport0p1', out: '/dev/vport0p2' });
  });

  test('configures the network it is given, the links up before their addresses and routes', () => {
    expect(plan.netlink).toEqual([
      linkUp(1, 1),
      linkUp(2, 2),
      addAddress(2, NETWORK.address, 24, 3),
      addDefaultRoute(2, NETWORK.gateway, 4),
      addAddress(2, NETWORK.address6, 64, 5),
      addDefaultRoute(2, NETWORK.gateway6, 6),
    ]);
    expect(plan.worker).toEqual(WORKER);
  });
});

describe("the guest's initramfs", () => {
  test('holds the root, the modules and the init with its plan', () => {
    const boot = guestBoot(MANIFEST, MODULES, WORKER, NETWORK);
    const members = cpioMembers(boot.initramfs);
    expect(members[0]).toMatchObject({ name: '.', mode: 0o040755 });
    const byName = new Map(members.map((member) => [member.name, member]));
    expect(byName.get('modules/netfs.ko')?.data.toString()).toBe('netfs');
    expect(byName.get('modules/9p.ko.xz')?.data.toString()).toBe('9p xz');
    const init = byName.get('init');
    expect(init?.mode).toBe(0o100755);
    expect(initPlanOf(init?.data as Buffer)).toEqual(guestPlan(MANIFEST, MODULES, WORKER, NETWORK));
    expect(boot.sha256).toBe(createHash('sha256').update(boot.initramfs).digest('hex'));
    expect(guestBoot(MANIFEST, MODULES, WORKER, NETWORK).sha256).toBe(boot.sha256);
  });
});
