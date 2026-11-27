import { createServer } from 'node:net';
import { connect } from 'node:tls';

// The first TLS record a client sends for a server name, as Bun's own TLS client writes it.
export const captureClientHello = (servername: string): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      let bytes = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length >= 5 && bytes.length >= 5 + bytes.readUInt16BE(3)) {
          socket.destroy();
          server.close();
          resolve(new Uint8Array(bytes.subarray(0, 5 + bytes.readUInt16BE(3))));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('no port'));
      connect({ host: '127.0.0.1', port: address.port, servername }).on('error', () => {});
    });
  });
