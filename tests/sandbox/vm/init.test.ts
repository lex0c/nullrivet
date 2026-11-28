import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type InitPlan,
  initProgram,
  MS_NOSUID,
  PLAN_ADDRESS,
} from '../../../src/sandbox/vm/init.ts';
import { INIT_CODE } from '../../../src/sandbox/vm/init-code.ts';
import { addAddress, addDefaultRoute, linkUp } from '../../../src/sandbox/vm/netlink.ts';
import { elfSegments, initPlanOf } from './readers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PLAN: InitPlan = {
  early: [{ source: 'proc', target: '/proc', type: 'proc', flags: MS_NOSUID, data: '' }],
  directories: [{ path: '/dev/pts', mode: 0o755 }],
  devices: [
    { source: 'devpts', target: '/dev/pts', type: 'devpts', flags: MS_NOSUID, data: 'mode=620' },
  ],
  links: [{ target: '/proc/self/fd', path: '/dev/fd' }],
  modules: [
    { path: '/modules/netfs.ko', flags: 0 },
    { path: '/modules/9p.ko.xz', flags: 4 },
  ],
  mounts: [
    { source: 'usr', target: '/usr', type: '9p', flags: 7, data: 'trans=virtio,version=9p2000.L' },
  ],
  checks: [
    { path: '/sys/class/virtio-ports/vport0p1/name', content: Buffer.from('nullrivet.in\n') },
  ],
  netlink: [linkUp(1, 1)],
  ports: { in: '/dev/vport0p1', out: '/dev/vport0p2' },
  worker: {
    path: '/.nullrivet-worker/nullrivet',
    argv: ['/.nullrivet-worker/nullrivet', '--nullrivet-sandbox-worker', '--tools', 'bash'],
    env: { PATH: '/usr/bin', HOME: '/home/ana' },
    cwd: '/home/ana/app',
    uid: 1000,
    gid: 1001,
  },
};

describe("the guest's init", () => {
  test('is a static x86-64 program: its code executable, its plan read-only, its stack not executable', () => {
    const elf = initProgram(PLAN);
    const [code, plan, stack] = elfSegments(elf);
    expect(code).toMatchObject({ type: 1, flags: 5, offset: 0, address: 0x400000 });
    expect(elf.readBigUInt64LE(24)).toBe(BigInt(0x400000 + 64 + 3 * 56));
    expect(elf.subarray(64 + 3 * 56, 64 + 3 * 56 + INIT_CODE.length)).toEqual(INIT_CODE);
    expect(plan).toMatchObject({ type: 1, flags: 4, address: PLAN_ADDRESS });
    expect((plan?.offset ?? 1) % 0x1000).toBe(0);
    expect(plan?.size).toBe(plan?.memory);
    expect(stack).toMatchObject({ type: 0x6474e551, flags: 6 });
  });

  test('holds the plan it was given, every pointer inside it', () => {
    expect(initPlanOf(initProgram(PLAN))).toEqual(PLAN);
  });

  test('refuses what the init could not be given', () => {
    expect(() => initProgram({ ...PLAN, ports: { in: '/dev/a\0b', out: '/dev/c' } })).toThrow(
      "the guest's init cannot be given",
    );
    expect(() => initProgram({ ...PLAN, worker: { ...PLAN.worker, uid: -1 } })).toThrow(
      "the guest's worker cannot run as -1",
    );
  });

  const tools = ['as', 'ld', 'objcopy'].every(
    (tool) => spawnSync(tool, ['--version']).status === 0,
  );
  test.if(process.arch === 'x64' && tools)('is the code of its source, assembled again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nullrivet-init-'));
    dirs.push(dir);
    const source = join(import.meta.dir, '../../../src/sandbox/vm/init.s');
    for (const [tool, ...args] of [
      ['as', '-o', join(dir, 'init.o'), source],
      ['ld', '-static', '-nostdlib', '-o', join(dir, 'init'), join(dir, 'init.o')],
      ['objcopy', '-O', 'binary', '-j', '.text', join(dir, 'init'), join(dir, 'code')],
    ] as [string, ...string[]][]) {
      const run = spawnSync(tool, args);
      expect(run.stderr.toString()).toBe('');
      expect(run.status).toBe(0);
    }
    const assembled = readFileSync(join(dir, 'code'));
    // On a change to the source, the new bytes to embed.
    if (!assembled.equals(INIT_CODE)) console.error(assembled.toString('base64'));
    expect(assembled.equals(INIT_CODE)).toBe(true);
  });
});

describe("the guest's network requests", () => {
  test('bring a link up, with an acknowledgement asked for', () => {
    expect(linkUp(2, 7).toString('hex')).toBe(
      // nlmsghdr: length 32, RTM_NEWLINK, REQUEST|ACK, sequence 7, port 0;
      // ifinfomsg: AF_UNSPEC, index 2, flags and change IFF_UP.
      '20000000100005000700000000000000' + '00000000020000000100000001000000',
    );
  });

  test('add an address and a default route, for IPv4 and IPv6', () => {
    expect(addAddress(2, '10.0.3.15', 24, 3).toString('hex')).toBe(
      // nlmsghdr: length 40, RTM_NEWADDR, REQUEST|ACK|EXCL|CREATE, sequence 3;
      // ifaddrmsg: AF_INET, /24, no flags, universe, index 2; IFA_LOCAL and IFA_ADDRESS.
      '28000000140005060300000000000000' +
        '0218000002000000' +
        '080002000a00030f' +
        '080001000a00030f',
    );
    const six = addAddress(2, 'fd00:3::15', 64, 4);
    expect(six.readUInt8(16)).toBe(10);
    expect(six.readUInt8(18)).toBe(0x02);
    expect(six.subarray(28, 44).toString('hex')).toBe('fd000003000000000000000000000015');
    const route = addDefaultRoute(2, '10.0.3.2', 5);
    expect(route.readUInt16LE(4)).toBe(24);
    expect(route.subarray(16, 28).toString('hex')).toBe('020000' + '00' + 'fe030001' + '00000000');
    expect(route.subarray(28).toString('hex')).toBe('080005000a000302' + '0800040002000000');
    expect(() => addDefaultRoute(2, 'gateway', 6)).toThrow('gateway is not an IP address');
    // An IPv6 address written with an IPv4 tail.
    expect(addAddress(2, '::ffff:10.0.3.2', 96, 7).subarray(28, 44).toString('hex')).toBe(
      '00000000000000000000ffff0a000302',
    );
  });
});
