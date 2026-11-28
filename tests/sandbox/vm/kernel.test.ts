import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import {
  GUEST_MODULES,
  guestModules,
  hostKernel,
  kernelRelease,
  moduleOrder,
  operatorKernel,
} from '../../../src/sandbox/vm/kernel.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nullrivet-kernel-'));
  dirs.push(dir);
  return dir;
};

// The start of a bzImage: the setup header's signature, protocol and the pointer to its version.
const bzImage = (version: string, protocol = 0x020f): Buffer => {
  const image = Buffer.alloc(0x1000);
  image.write('HdrS', 0x202, 'latin1');
  image.writeUInt16LE(protocol, 0x206);
  image.writeUInt16LE(0x0400 - 0x200, 0x20e);
  image.write(`${version}\0`, 0x0400, 'latin1');
  return image;
};

describe("the guest's kernel", () => {
  test('reads the release a bzImage names', () => {
    expect(kernelRelease(bzImage('6.12.112-1-MANJARO (linux612@manjaro) #1 SMP'))).toBe(
      '6.12.112-1-MANJARO',
    );
    expect(kernelRelease(bzImage('6.8.0-51-generic (buildd@lcy02) #52'))).toBe('6.8.0-51-generic');
  });

  test('takes no release from what is not a bzImage, or names none a path can hold', () => {
    const elf = Buffer.alloc(0x1000);
    elf.write('\x7fELF', 0, 'latin1');
    expect(kernelRelease(elf)).toBeNull();
    expect(kernelRelease(Buffer.alloc(0x100))).toBeNull();
    expect(kernelRelease(bzImage('6.1.0', 0x0105))).toBeNull();
    expect(kernelRelease(bzImage('../../etc #1'))).toBeNull();
    expect(kernelRelease(bzImage('6.1/x #1'))).toBeNull();
    const outside = bzImage('6.1.0');
    outside.writeUInt16LE(0xff00, 0x20e);
    expect(kernelRelease(outside)).toBeNull();
  });

  test('reads a kernel once, and names it by the hash of the bytes it read', () => {
    const dir = scratch();
    const image = bzImage('6.9.1-test #1');
    writeFileSync(join(dir, 'vmlinuz'), image);
    expect(operatorKernel(join(dir, 'vmlinuz'))).toMatchObject({
      source: 'operator',
      release: '6.9.1-test',
      sha256: createHash('sha256').update(image).digest('hex'),
    });
    writeFileSync(join(dir, 'other'), Buffer.from('not a kernel'));
    expect(operatorKernel(join(dir, 'other'))).toEqual({
      error: `${join(dir, 'other')} is not an x86 kernel image (bzImage)`,
    });
    mkdirSync(join(dir, 'directory'));
    expect(operatorKernel(join(dir, 'directory'))).toEqual({
      error: `the kernel ${join(dir, 'directory')} cannot be read: it is not a regular file`,
    });
  });

  test.if(process.getuid?.() !== 0)('says what to do with a kernel readable by root alone', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'vmlinuz'), bzImage('6.9.1-test #1'));
    chmodSync(join(dir, 'vmlinuz'), 0o000);
    expect(operatorKernel(join(dir, 'vmlinuz'))).toEqual({
      error: `the kernel ${join(dir, 'vmlinuz')} cannot be read: it is readable by root alone, as some distributions keep it: make it readable (chmod 0644), or name another kernel with --vm-kernel`,
    });
  });

  test("finds the host's kernel of its release, beside its modules or in /boot", () => {
    const root = scratch();
    mkdirSync(join(root, 'boot'));
    mkdirSync(join(root, 'lib/modules/6.9.1-test'), { recursive: true });
    writeFileSync(join(root, 'boot/vmlinuz-6.9.1-test'), bzImage('6.9.1-test #1'));
    expect(hostKernel('6.9.1-test', root)).toMatchObject({
      source: 'distribution',
      path: join(root, 'boot/vmlinuz-6.9.1-test'),
      release: '6.9.1-test',
    });
    // Beside the modules first: the image the distribution installed with them.
    writeFileSync(join(root, 'lib/modules/6.9.1-test/vmlinuz'), bzImage('6.9.1-test #2'));
    expect(hostKernel('6.9.1-test', root)).toMatchObject({
      path: join(root, 'lib/modules/6.9.1-test/vmlinuz'),
    });
  });

  test('refuses a kernel of another release, and says where it looked for one', () => {
    const root = scratch();
    mkdirSync(join(root, 'boot'));
    writeFileSync(join(root, 'boot/vmlinuz-6.9.1-test'), bzImage('6.9.0-old #1'));
    expect(hostKernel('6.9.1-test', root)).toEqual({
      error: `${join(root, 'boot/vmlinuz-6.9.1-test')} is the kernel of release 6.9.0-old, not of 6.9.1-test, which the host runs`,
    });
    expect(hostKernel('6.9.2', root)).toEqual({
      error:
        'the kernel of release 6.9.2 is in none of /lib/modules/6.9.2/vmlinuz, /boot/vmlinuz-6.9.2: name one with --vm-kernel',
    });
    expect(hostKernel('../x', root)).toEqual({ error: "the host's release ../x names no kernel" });
  });

  const own = `/lib/modules/${release()}/vmlinuz`;
  test.if(process.platform === 'linux' && existsSync(own))("reads this host's own kernel", () => {
    const kernel = hostKernel(release());
    if ('error' in kernel) {
      expect(kernel.error).toContain('readable by root alone');
      return;
    }
    expect(kernel).toMatchObject({ source: 'distribution', path: own, release: release() });
  });
});

describe("the guest's modules", () => {
  const DEP = [
    'kernel/fs/netfs/netfs.ko.zst:',
    'kernel/net/9p/9pnet.ko.zst: kernel/fs/netfs/netfs.ko.zst',
    'kernel/net/9p/9pnet_virtio.ko.zst: kernel/net/9p/9pnet.ko.zst kernel/fs/netfs/netfs.ko.zst',
    'kernel/fs/9p/9p.ko.zst: kernel/net/9p/9pnet.ko.zst kernel/fs/netfs/netfs.ko.zst',
    'kernel/drivers/net/net_failover.ko.zst: kernel/net/core/failover.ko.zst',
    'kernel/net/core/failover.ko.zst:',
    'kernel/drivers/net/virtio_net.ko.zst: kernel/drivers/net/net_failover.ko.zst kernel/net/core/failover.ko.zst',
    '',
  ].join('\n');

  test('loads each module after those it depends on, and none the kernel has built in', () => {
    const order = moduleOrder(DEP, 'kernel/drivers/char/virtio_console.ko\n', [
      '9pnet_virtio',
      '9p',
      'virtio_console',
      'virtio-net',
    ]);
    expect(order).toEqual([
      { name: 'netfs', path: 'kernel/fs/netfs/netfs.ko.zst' },
      { name: '9pnet', path: 'kernel/net/9p/9pnet.ko.zst' },
      { name: '9pnet_virtio', path: 'kernel/net/9p/9pnet_virtio.ko.zst' },
      { name: '9p', path: 'kernel/fs/9p/9p.ko.zst' },
      { name: 'failover', path: 'kernel/net/core/failover.ko.zst' },
      { name: 'net_failover', path: 'kernel/drivers/net/net_failover.ko.zst' },
      { name: 'virtio_net', path: 'kernel/drivers/net/virtio_net.ko.zst' },
    ]);
  });

  test('names a module the kernel lacks, and refuses an index it does not write', () => {
    expect(moduleOrder(DEP, '', ['virtio_console'])).toEqual({
      error: 'the kernel has no module virtio_console, which the guest needs',
    });
    expect(moduleOrder('kernel/../../etc/x.ko:\n', '', ['x'])).toMatchObject({
      error: expect.stringContaining("modules.dep holds a line the kernel's tools do not write"),
    });
    expect(moduleOrder('/abs/x.ko:\n', '', ['x'])).toMatchObject({ error: expect.any(String) });
    expect(moduleOrder('no colon here\n', '', ['x'])).toMatchObject({ error: expect.any(String) });
    expect(moduleOrder('a/a.ko: a/b.ko\na/b.ko: a/a.ko\n', '', ['a'])).toEqual({
      error: 'the modules a depends on depend on it',
    });
  });

  test("refuses modules its kernel's configuration says it cannot decompress", () => {
    const root = scratch();
    const boot = scratch();
    const dir = join(root, '6.9.1-test');
    mkdirSync(join(dir, 'kernel'), { recursive: true });
    writeFileSync(join(dir, 'kernel/c.ko.xz'), Buffer.from('xz bytes'));
    writeFileSync(join(dir, 'modules.dep'), 'kernel/c.ko.xz:\n');
    writeFileSync(join(dir, 'modules.builtin'), '');
    // No configuration to tell: the kernel is left to try.
    expect(guestModules('6.9.1-test', root, ['c'], boot)).toHaveLength(1);
    writeFileSync(join(boot, 'config-6.9.1-test'), 'CONFIG_MODULE_COMPRESS_XZ=y\n');
    expect(guestModules('6.9.1-test', root, ['c'], boot)).toEqual({
      error:
        'the kernel of release 6.9.1-test cannot decompress its modules, which the host cannot decompress either (xz)',
    });
    // The configuration beside the modules comes first.
    writeFileSync(join(dir, 'config'), 'CONFIG_MODULE_DECOMPRESS=y\nCONFIG_MODULE_COMPRESS_XZ=y\n');
    expect(guestModules('6.9.1-test', root, ['c'], boot)).toHaveLength(1);
  });

  test('loads the virtio devices on PCI first, unless the kernel has them built in', () => {
    expect(GUEST_MODULES[0]).toBe('virtio_pci');
    expect(
      moduleOrder(
        'kernel/virtio_pci.ko:\nkernel/9p.ko:\n',
        'kernel/drivers/virtio/virtio_pci.ko\n',
        ['virtio_pci', '9p'],
      ),
    ).toEqual([{ name: '9p', path: 'kernel/9p.ko' }]);
  });

  test('decompresses what the host can, and leaves the rest to the kernel', () => {
    const root = scratch();
    const dir = join(root, '6.9.1-test');
    mkdirSync(join(dir, 'kernel'), { recursive: true });
    const plain = Buffer.from('module a');
    writeFileSync(join(dir, 'kernel/a.ko.zst'), zstdCompressSync(plain));
    writeFileSync(join(dir, 'kernel/b.ko.gz'), gzipSync(Buffer.from('module b')));
    writeFileSync(join(dir, 'kernel/c.ko.xz'), Buffer.from('xz bytes'));
    writeFileSync(join(dir, 'kernel/d.ko'), Buffer.from('module d'));
    writeFileSync(
      join(dir, 'modules.dep'),
      'kernel/a.ko.zst:\nkernel/b.ko.gz: kernel/a.ko.zst\nkernel/c.ko.xz:\nkernel/d.ko: kernel/c.ko.xz\n',
    );
    writeFileSync(join(dir, 'modules.builtin'), '');
    const modules = guestModules('6.9.1-test', root, ['b', 'd']);
    if ('error' in modules) throw new Error(modules.error);
    expect(
      modules.map(({ name, data, compressed }) => [name, data.toString(), compressed]),
    ).toEqual([
      ['a', 'module a', false],
      ['b', 'module b', false],
      ['c', 'xz bytes', true],
      ['d', 'module d', false],
    ]);
    expect(modules[0]?.sha256).toBe(
      createHash('sha256').update(zstdCompressSync(plain)).digest('hex'),
    );
    expect(guestModules('6.9.2', root, ['a'])).toMatchObject({
      error: expect.stringContaining('the modules of release 6.9.2 cannot be read'),
    });
  });
});
