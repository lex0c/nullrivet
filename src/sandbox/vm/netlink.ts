import { isIP } from 'node:net';
import { parseNetwork } from '../network/ruleset.ts';

// The netlink requests that configure the guest's network, built on the host so that the init only
// sends them and checks each acknowledgement. Each asks for one: NLM_F_ACK makes the kernel answer
// with an error message whose error is zero on success.

const NLM_F_REQUEST = 0x1;
const NLM_F_ACK = 0x4;
const NLM_F_EXCL = 0x200;
const NLM_F_CREATE = 0x400;
const RTM_NEWLINK = 16;
const RTM_NEWADDR = 20;
const RTM_NEWROUTE = 24;
const AF_UNSPEC = 0;
const AF_INET = 2;
const AF_INET6 = 10;
const IFF_UP = 0x1;
const IFA_ADDRESS = 1;
const IFA_LOCAL = 2;
// The guest's network has no other host to collide with: its address is used at once.
const IFA_F_NODAD = 0x02;
const RTA_OIF = 4;
const RTA_GATEWAY = 5;
const RT_TABLE_MAIN = 254;
const RTPROT_BOOT = 3;
const RT_SCOPE_UNIVERSE = 0;
const RTN_UNICAST = 1;

const aligned = (bytes: Buffer): Buffer =>
  Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);

const attribute = (type: number, data: Buffer): Buffer => {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(4 + data.length, 0);
  head.writeUInt16LE(type, 2);
  return aligned(Buffer.concat([head, data]));
};

const message = (type: number, flags: number, sequence: number, body: Buffer): Buffer => {
  const head = Buffer.alloc(16);
  head.writeUInt32LE(16 + body.length, 0);
  head.writeUInt16LE(type, 4);
  head.writeUInt16LE(NLM_F_REQUEST | NLM_F_ACK | flags, 6);
  head.writeUInt32LE(sequence, 8);
  return Buffer.concat([head, body]);
};

// An address's family and bytes, in network order.
const addressBytes = (address: string): { family: number; bytes: Buffer } => {
  const parsed = isIP(address) === 0 ? null : parseNetwork(address);
  if (parsed === null) throw new Error(`${address} is not an IP address`);
  if (parsed.family === 4) {
    return { family: AF_INET, bytes: Buffer.from(parsed.address.split('.').map(Number)) };
  }
  const bytes = Buffer.alloc(16);
  for (const [index, group] of parsed.address.split(':').entries()) {
    bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2);
  }
  return { family: AF_INET6, bytes };
};

// Brings the interface of `index` up.
export const linkUp = (index: number, sequence: number): Buffer => {
  const info = Buffer.alloc(16);
  info.writeUInt8(AF_UNSPEC, 0);
  info.writeInt32LE(index, 4);
  info.writeUInt32LE(IFF_UP, 8);
  info.writeUInt32LE(IFF_UP, 12);
  return message(RTM_NEWLINK, 0, sequence, info);
};

// Gives the interface of `index` an address in a network of `prefix` bits.
export const addAddress = (
  index: number,
  address: string,
  prefix: number,
  sequence: number,
): Buffer => {
  const { family, bytes } = addressBytes(address);
  const head = Buffer.alloc(8);
  head.writeUInt8(family, 0);
  head.writeUInt8(prefix, 1);
  head.writeUInt8(family === AF_INET6 ? IFA_F_NODAD : 0, 2);
  head.writeUInt8(RT_SCOPE_UNIVERSE, 3);
  head.writeUInt32LE(index, 4);
  return message(
    RTM_NEWADDR,
    NLM_F_CREATE | NLM_F_EXCL,
    sequence,
    Buffer.concat([head, attribute(IFA_LOCAL, bytes), attribute(IFA_ADDRESS, bytes)]),
  );
};

// Routes everything through `gateway`, by the interface of `index`.
export const addDefaultRoute = (index: number, gateway: string, sequence: number): Buffer => {
  const { family, bytes } = addressBytes(gateway);
  const head = Buffer.alloc(12);
  head.writeUInt8(family, 0);
  head.writeUInt8(RT_TABLE_MAIN, 4);
  head.writeUInt8(RTPROT_BOOT, 5);
  head.writeUInt8(RT_SCOPE_UNIVERSE, 6);
  head.writeUInt8(RTN_UNICAST, 7);
  const oif = Buffer.alloc(4);
  oif.writeUInt32LE(index, 0);
  return message(
    RTM_NEWROUTE,
    NLM_F_CREATE | NLM_F_EXCL,
    sequence,
    Buffer.concat([head, attribute(RTA_GATEWAY, bytes), attribute(RTA_OIF, oif)]),
  );
};
