import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Network, parseNetwork } from '../../../src/sandbox/network/ruleset.ts';
import { cpioArchive } from '../../../src/sandbox/vm/cpio.ts';
import {
  type GuestView,
  guestManifest,
  type HostEntries,
  hostEntries,
} from '../../../src/sandbox/vm/manifest.ts';
import { guestNetwork, qemuArgs } from '../../../src/sandbox/vm/qemu.ts';

const VIEW: GuestView = {
  project: '/home/ana/work/app',
  home: '/home/ana',
  readOnlyDirs: ['/home/ana/.local/state/nullrivet/reports'],
  workerDir: '/.nullrivet-worker',
  identity: { passwd: 'ana:x:1000:1000::/home/ana:/bin/sh\n', group: 'ana:x:1000:\n' },
};

// A host with a merged /usr, but for /lib64.
const HOST: HostEntries = {
  root: [
    { path: '/bin', kind: 'link', target: 'usr/bin' },
    { path: '/lib', kind: 'link', target: 'usr/lib' },
    { path: '/lib64', kind: 'directory' },
  ],
  etc: [
    { path: '/etc/ld.so.cache', kind: 'file', data: Buffer.from('cache') },
    { path: '/etc/alternatives', kind: 'directory' },
    { path: '/etc/alternatives/editor', kind: 'link', target: '/usr/bin/vim' },
    { path: '/etc/localtime', kind: 'link', target: '/usr/share/zoneinfo/UTC' },
  ],
};

const manifest = (view: Partial<GuestView> = {}, host: HostEntries = HOST) => {
  const built = guestManifest({ ...VIEW, ...view }, host);
  if ('error' in built) throw new Error(built.error);
  return built;
};

describe("the guest's manifest", () => {
  test('exports each directory the profile binds, read-only where it binds it so, each after any it is inside', () => {
    expect(manifest().exports).toEqual([
      { tag: 'usr', path: '/usr', readOnly: true },
      { tag: 'rootlib64', path: '/lib64', readOnly: true },
      { tag: 'worker', path: '/.nullrivet-worker', readOnly: true },
      { tag: 'tmp', path: '/tmp', readOnly: false },
      { tag: 'hosts', path: '/etc/nullrivet', readOnly: true },
      { tag: 'home', path: '/home/ana', readOnly: false },
      { tag: 'project', path: '/home/ana/work/app', readOnly: false },
      { tag: 'ro0', path: '/home/ana/.local/state/nullrivet/reports', readOnly: true },
    ]);
  });

  test('gives the guest a root, and every directory of it, that only root may write to', () => {
    const { entries } = manifest();
    expect(entries[0]).toEqual({ kind: 'directory', path: '.', mode: 0o755 });
    for (const entry of entries) {
      if (entry.kind === 'directory') expect(entry.mode).toBe(0o755);
    }
  });

  test("copies the files bound one by one into the initramfs, and exports nothing else of the host's /etc", () => {
    const { exports, entries } = manifest();
    expect(exports.filter(({ path }) => path === '/etc' || path.startsWith('/etc/'))).toEqual([
      { tag: 'hosts', path: '/etc/nullrivet', readOnly: true },
    ]);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.get('etc/passwd')).toMatchObject({
      kind: 'file',
      data: Buffer.from(VIEW.identity.passwd),
    });
    expect(byPath.get('etc/group')).toMatchObject({ kind: 'file' });
    expect(byPath.get('etc/nsswitch.conf')).toMatchObject({ kind: 'file' });
    expect(byPath.get('etc/hosts')).toEqual({
      kind: 'link',
      path: 'etc/hosts',
      target: '/etc/nullrivet/hosts',
    });
    expect(byPath.get('etc/ld.so.cache')).toMatchObject({
      kind: 'file',
      data: Buffer.from('cache'),
    });
    expect(byPath.get('etc/alternatives/editor')).toEqual({
      kind: 'link',
      path: 'etc/alternatives/editor',
      target: '/usr/bin/vim',
    });
    expect(byPath.get('bin')).toEqual({ kind: 'link', path: 'bin', target: 'usr/bin' });
    expect(byPath.get('dev/console')).toMatchObject({
      kind: 'char',
      major: 5,
      minor: 1,
      mode: 0o600,
    });
    for (const path of [
      'proc',
      'sys',
      'usr',
      'lib64',
      'tmp',
      'etc/nullrivet',
      'home/ana/work/app',
    ]) {
      expect(byPath.get(path)).toMatchObject({ kind: 'directory' });
    }
    // The entries make an archive: each directory before what it holds.
    expect(() => cpioArchive(entries)).not.toThrow();
  });

  test('refuses to give the guest what it must not reach', () => {
    for (const [view, error] of [
      [{ readOnlyDirs: ['/dev'] }, 'the guest cannot be given /dev'],
      [{ readOnlyDirs: ['/proc/1'] }, 'the guest cannot be given /proc/1'],
      [{ readOnlyDirs: ['/etc'] }, 'the guest cannot be given /etc'],
      [{ readOnlyDirs: ['/etc/ssh'] }, 'the guest cannot be given /etc/ssh'],
      [{ project: '/modules/app' }, 'the guest cannot be given /modules/app'],
      [{ readOnlyDirs: ['/init'] }, 'the guest cannot be given /init'],
      [{ project: '/' }, 'the guest cannot be given /'],
      [{ project: 'relative/app' }, 'the guest cannot be given relative/app'],
      [{ project: '/home/ana/../root' }, 'the guest cannot be given /home/ana/../root'],
      [{ project: '/home/ana' }, 'the guest is given /home/ana twice'],
      [
        { readOnlyDirs: ['/bin/tools'] },
        'the guest cannot be given /bin/tools: it is under a link of the root',
      ],
    ] as [Partial<GuestView>, string][]) {
      expect(guestManifest({ ...VIEW, ...view }, HOST)).toEqual({ error });
    }
  });

  test("copies the host's entries it finds, and says which cannot be read", () => {
    const root = mkdtempSync(join(tmpdir(), 'nullrivet-host-'));
    try {
      mkdirSync(join(root, 'etc/alternatives'), { recursive: true });
      mkdirSync(join(root, 'usr/lib'), { recursive: true });
      symlinkSync('usr/lib', join(root, 'lib'));
      symlinkSync('/usr/bin/vim', join(root, 'etc/alternatives/editor'));
      writeFileSync(join(root, 'etc/alternatives/README'), 'not a link');
      writeFileSync(join(root, 'etc/ld.so.cache'), 'cache');
      expect(hostEntries(root)).toEqual({
        root: [{ path: '/lib', kind: 'link', target: 'usr/lib' }],
        etc: [
          { path: '/etc/ld.so.cache', kind: 'file', data: Buffer.from('cache') },
          { path: '/etc/alternatives', kind: 'directory' },
          { path: '/etc/alternatives/editor', kind: 'link', target: '/usr/bin/vim' },
        ],
      });
      if (process.getuid?.() !== 0) {
        chmodSync(join(root, 'etc/ld.so.cache'), 0o000);
        expect(hostEntries(root)).toMatchObject({
          error: expect.stringContaining('/etc/ld.so.cache cannot be read for the guest'),
        });
        chmodSync(join(root, 'etc/ld.so.cache'), 0o644);
        // A directory without search permission: the entry cannot even be looked at.
        chmodSync(join(root, 'etc'), 0o600);
        expect(hostEntries(root)).toMatchObject({
          error: expect.stringContaining('/etc/ld.so.cache cannot be read for the guest'),
        });
        chmodSync(join(root, 'etc'), 0o755);
      }
      for (let index = 0; index < 4097; index += 1) {
        symlinkSync('/usr/bin/true', join(root, `etc/alternatives/a${index}`));
      }
      expect(hostEntries(root)).toEqual({
        error: '/etc/alternatives holds more than 4096 entries for the guest',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.if(process.platform === 'linux')(
    "reads this host's root and /etc as the profile binds them",
    () => {
      const host = hostEntries();
      if ('error' in host) throw new Error(host.error);
      expect(
        host.root
          .map(({ path }) => path)
          .every((path) => ['/bin', '/sbin', '/lib', '/lib64', '/lib32'].includes(path)),
      ).toBe(true);
      expect(host.etc.every(({ path }) => path.startsWith('/etc/'))).toBe(true);
      expect(() => cpioArchive(manifest({}, host).entries)).not.toThrow();
    },
  );
});

describe("the guest's QEMU", () => {
  const network = guestNetwork([]);
  if ('error' in network) throw new Error(network.error);
  const args = (
    exports = manifest().exports,
    paths = { kernel: '/vm/kernel', initrd: '/vm/initrd' },
  ) => qemuArgs({ ...paths, memoryMiB: 1024, cpus: 2, exports, network });

  test('takes the kernel and the initramfs by their paths as written, where an option list would not', () => {
    const line = args(undefined, { kernel: '/vm/a,b', initrd: '/vm/c,d' });
    expect(line[line.indexOf('-kernel') + 1]).toBe('/vm/a,b');
    expect(line[line.indexOf('-initrd') + 1]).toBe('/vm/c,d');
    expect(() => args(undefined, { kernel: '/vm/a\nb', initrd: '/vm/c' })).toThrow(
      'QEMU cannot be given',
    );
  });

  test("ends with a status of its own when the guest's init fails", () => {
    expect(args().join(' ')).toContain('-device isa-debug-exit,iobase=0x501,iosize=0x01');
  });

  test('has no device, monitor or configuration it was not given', () => {
    const line = args();
    for (const flag of ['-nodefaults', '-no-user-config', '-no-reboot'])
      expect(line).toContain(flag);
    expect(line.slice(line.indexOf('-monitor'), line.indexOf('-monitor') + 2)).toEqual([
      '-monitor',
      'none',
    ]);
    expect(line[line.indexOf('-sandbox') + 1]).toStartWith('on,');
    expect(line[line.indexOf('-machine') + 1]).toBe('q35,accel=kvm');
    const netdev = line[line.indexOf('-netdev') + 1] as string;
    for (const offered of ['hostfwd', 'guestfwd', 'smb', 'tftp', 'bootfile']) {
      expect(netdev).not.toContain(offered);
    }
  });

  test('runs the protocol on the sockets it inherits, one port each way, on the first slot', () => {
    const line = args().join(' ');
    expect(line).toContain('-chardev socket,id=in,fd=3');
    expect(line).toContain('-chardev socket,id=out,fd=4');
    expect(line).toContain('-device virtio-serial-pci,id=ports,addr=0x1');
    expect(line).toContain('virtserialport,bus=ports.0,nr=1,chardev=in,name=nullrivet.in');
    expect(line).toContain('virtserialport,bus=ports.0,nr=2,chardev=out,name=nullrivet.out');
  });

  test('exports each directory of the manifest, read-only where it says so, and escapes its path', () => {
    const line = args([
      { tag: 'usr', path: '/usr', readOnly: true },
      { tag: 'project', path: '/home/ana/a,b', readOnly: false },
    ]);
    expect(line).toContain(
      'local,id=usr,path=/usr,security_model=none,readonly=on,multidevs=remap',
    );
    expect(line).toContain(
      'local,id=project,path=/home/ana/a,,b,security_model=none,readonly=off,multidevs=remap',
    );
    expect(() => args([{ tag: 'Bad Tag', path: '/usr', readOnly: true }])).toThrow(
      'a 9p export cannot be tagged Bad Tag',
    );
    expect(() => args([{ tag: 'p', path: '/home/a\nb', readOnly: true }])).toThrow(
      'QEMU cannot be given',
    );
  });
});

describe("the guest's network", () => {
  const network = (text: string): Network => parseNetwork(text) as Network;

  test('takes the first private networks that hold no address of the scope', () => {
    expect(guestNetwork([network('198.51.100.0/24'), network('2001:db8::/32')])).toMatchObject({
      network: '10.0.3.0/24',
      address: '10.0.3.15',
      gateway: '10.0.3.2',
      dns: '10.0.3.3',
      network6: 'fd00:3::/64',
      address6: 'fd00:3::15',
    });
    // A scope within the first, or around it, moves the guest to the next.
    expect(guestNetwork([network('10.0.3.50/32'), network('fd00:3::/32')])).toMatchObject({
      network: '172.30.3.0/24',
      network6: 'fd4e:7276::/64',
    });
    expect(guestNetwork([network('10.0.0.0/8'), network('172.16.0.0/12')])).toMatchObject({
      network: '192.168.233.0/24',
    });
  });

  test('refuses a scope that holds every network the guest could have', () => {
    expect(
      guestNetwork([
        network('10.0.0.0/8'),
        network('172.16.0.0/12'),
        network('192.168.0.0/16'),
        network('100.64.0.0/10'),
      ]),
    ).toMatchObject({
      error: expect.stringContaining('the scope holds every network the guest could have'),
    });
  });
});
