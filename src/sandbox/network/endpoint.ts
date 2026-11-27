import { dlopen, FFIType, ptr } from 'bun:ffi';

// The proxy's listening socket, made and held by the host; the proxy's process listens on a copy
// of it. Owned by the proxy, the port would be freed by the proxy's end while pasta still forwards
// the sandbox's connections there, and any program could take it. Held here, the port stays bound
// until the network is closed, and a connection meanwhile waits unanswered. Made close-on-exec, so
// that no other program the host starts, the sandbox's launcher included, holds it.
export interface ProxyEndpoint {
  fd: number;
  port: number;
  close(): void;
}

const AF_INET = 2;
const SOCK_STREAM = 1;
const SOCK_CLOEXEC = 0x80000;
const SOCKADDR_IN_BYTES = 16;
const BACKLOG = 512;

let libc: ReturnType<typeof load> | null = null;
const load = () =>
  dlopen('libc.so.6', {
    socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    bind: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    listen: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    getsockname: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  });

// A socket listening on 127.0.0.1, on a port the system chooses.
export const proxyEndpoint = (): ProxyEndpoint => {
  libc ??= load();
  const { socket, bind, listen, getsockname, close } = libc.symbols;
  const fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) throw new Error("the proxy's socket could not be made");
  // struct sockaddr_in: the family in the host's order, the port and the address in the network's.
  const address = new Uint8Array(SOCKADDR_IN_BYTES);
  const view = new DataView(address.buffer);
  view.setUint16(0, AF_INET, true);
  address.set([127, 0, 0, 1], 4);
  const length = new Uint32Array([SOCKADDR_IN_BYTES]);
  if (
    bind(fd, ptr(address), SOCKADDR_IN_BYTES) !== 0 ||
    listen(fd, BACKLOG) !== 0 ||
    getsockname(fd, ptr(address), ptr(length)) !== 0
  ) {
    close(fd);
    throw new Error("the proxy's socket could not listen on the loopback");
  }
  let open = true;
  return {
    fd,
    port: view.getUint16(2, false),
    close: () => {
      if (open) {
        open = false;
        close(fd);
      }
    },
  };
};
