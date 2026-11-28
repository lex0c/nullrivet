import { overlaps } from '../engagement.ts';
import { type Network, parseNetwork } from '../network/ruleset.ts';
import type { GuestExport } from './manifest.ts';

// The command line of the QEMU that runs the guest inside the sandbox. Only what the guest needs:
// no default devices, no configuration file, no display, no monitor, and QEMU's own seccomp filter
// on top of the profile's.
//
// The protocol runs on two virtio-serial ports, one per direction, over the sockets the sandbox
// hands QEMU as descriptors 3 and 4: QEMU opens nothing for them, so the profile's refusal of new
// Unix sockets holds. Their device takes the first slot after the host bridge, 0x1, before any
// other: devices given no slot take the lowest free one, and the kernel numbers virtio devices in
// slot order, so this is the guest's first, whose ports are /dev/vport0p1 and /dev/vport0p2. The
// init checks their names before it uses them.
//
// The guest's network is QEMU's user networking, whose connections are QEMU's sockets in the
// sandbox's namespace, under its ruleset. It offers nothing of its own beyond its addresses: no
// forwarded port, no shared folder, no boot server. Its networks must hold no address of the
// scope: one would be on the guest's own link, where nothing answers for it.

export interface GuestNetwork {
  network: string;
  address: string;
  prefix: number;
  gateway: string;
  dns: string;
  network6: string;
  address6: string;
  prefix6: number;
  gateway6: string;
  dns6: string;
}

// Private networks for the guest, each tried in turn, the first that holds no address of the
// scope taken: the address the guest takes, its gateway and its resolver are its hosts 15, 2 and 3.
const CANDIDATES_V4 = ['10.0.3', '172.30.3', '192.168.233', '100.115.92'];
const CANDIDATES_V6 = ['fd00:3', 'fd4e:7276', 'fdcc:6a5'];

// The guest's networks for a scope of `networks`, or why none can be had.
export const guestNetwork = (networks: readonly Network[]): GuestNetwork | { error: string } => {
  const free = (text: string) => {
    const candidate = parseNetwork(text) as Network;
    return !networks.some((network) => overlaps(network, candidate));
  };
  const v4 = CANDIDATES_V4.find((prefix) => free(`${prefix}.0/24`));
  const v6 = CANDIDATES_V6.find((prefix) => free(`${prefix}::/64`));
  if (v4 === undefined || v6 === undefined) {
    return {
      error: `the scope holds every network the guest could have (${[...CANDIDATES_V4.map((prefix) => `${prefix}.0/24`), ...CANDIDATES_V6.map((prefix) => `${prefix}::/64`)].join(', ')})`,
    };
  }
  return {
    network: `${v4}.0/24`,
    address: `${v4}.15`,
    prefix: 24,
    gateway: `${v4}.2`,
    dns: `${v4}.3`,
    network6: `${v6}::/64`,
    address6: `${v6}::15`,
    prefix6: 64,
    gateway6: `${v6}::2`,
    dns6: `${v6}::3`,
  };
};

// The status QEMU ends with when the guest's init fails: its debug-exit device turns the 1 the init
// writes into (1 << 1) | 1.
export const INIT_FAILED_STATUS = 3;

export const PROTOCOL_PORTS = { in: 'nullrivet.in', out: 'nullrivet.out' };

export interface QemuOptions {
  // In the sandbox.
  kernel: string;
  initrd: string;
  memoryMiB: number;
  cpus: number;
  exports: readonly GuestExport[];
  network: GuestNetwork;
}

const plainValue = (value: string): string => {
  if (/[\0\n]/.test(value)) throw new Error(`QEMU cannot be given ${JSON.stringify(value)}`);
  return value;
};

// A value inside an option list, where QEMU reads `,` as the end of the value unless it is doubled.
const optionValue = (value: string): string => plainValue(value).replaceAll(',', ',,');

const TAG = /^[a-z][a-z0-9]{0,30}$/;

// The kernel's command line: its console on the first serial port, the init from the initramfs,
// and a panic that ends the machine at once, which -no-reboot turns into QEMU's exit.
export const KERNEL_COMMAND_LINE = 'console=ttyS0 panic=-1 rdinit=/init quiet loglevel=4';

export const qemuArgs = (options: QemuOptions): string[] => {
  if (!Number.isInteger(options.memoryMiB) || options.memoryMiB < 128) {
    throw new Error(`the guest cannot have ${options.memoryMiB} MiB of memory`);
  }
  if (!Number.isInteger(options.cpus) || options.cpus < 1) {
    throw new Error(`the guest cannot have ${options.cpus} processors`);
  }
  const net = options.network;
  return [
    '-nodefaults',
    '-no-user-config',
    '-display',
    'none',
    '-monitor',
    'none',
    '-no-reboot',
    '-sandbox',
    'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny',
    '-machine',
    'q35,accel=kvm',
    '-cpu',
    'host',
    '-m',
    String(options.memoryMiB),
    '-smp',
    String(options.cpus),
    '-kernel',
    plainValue(options.kernel),
    '-initrd',
    plainValue(options.initrd),
    '-append',
    KERNEL_COMMAND_LINE,
    '-device',
    'isa-debug-exit,iobase=0x501,iosize=0x01',
    '-chardev',
    'socket,id=console,fd=2',
    '-serial',
    'chardev:console',
    '-device',
    'virtio-serial-pci,id=ports,addr=0x1',
    '-chardev',
    'socket,id=in,fd=3',
    '-device',
    `virtserialport,bus=ports.0,nr=1,chardev=in,name=${PROTOCOL_PORTS.in}`,
    '-chardev',
    'socket,id=out,fd=4',
    '-device',
    `virtserialport,bus=ports.0,nr=2,chardev=out,name=${PROTOCOL_PORTS.out}`,
    ...options.exports.flatMap((entry) => {
      if (!TAG.test(entry.tag)) throw new Error(`a 9p export cannot be tagged ${entry.tag}`);
      return [
        '-fsdev',
        `local,id=${entry.tag},path=${optionValue(entry.path)},security_model=none,readonly=${entry.readOnly ? 'on' : 'off'},multidevs=remap`,
        '-device',
        `virtio-9p-pci,fsdev=${entry.tag},mount_tag=${entry.tag}`,
      ];
    }),
    '-netdev',
    `user,id=net,net=${net.network},host=${net.gateway},dns=${net.dns},ipv6-net=${net.network6},ipv6-host=${net.gateway6},ipv6-dns=${net.dns6}`,
    '-device',
    'virtio-net-pci,netdev=net',
  ];
};
