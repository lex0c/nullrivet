// A worker that breaks the protocol in the way FAKE_SCENARIO names, for the host's checks.
import { createReadStream, createWriteStream } from 'node:fs';

const out = createWriteStream('', { fd: 4 });
const send = (value: unknown): void => {
  out.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
};
const tools = (process.env.FAKE_TOOLS ?? 'read_file').split(',');
const scenario = process.env.FAKE_SCENARIO ?? 'echo';
const result = (content: string) => ({ content, isError: false });

if (scenario === 'no-ready') {
  setInterval(() => undefined, 1_000);
} else {
  send({ type: 'worker.ready', protocol: 1, tools });
}
if (scenario === 'ready-twice') send({ type: 'worker.ready', protocol: 1, tools });
if (scenario === 'stderr-then-exit') {
  process.stderr.write('setting up the namespace failed\n');
  process.exit(3);
}

let buffer = '';
createReadStream('', { fd: 3 }).on('data', (chunk) => {
  buffer += chunk.toString();
  for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.type !== 'tool.execute') continue;
    const id: string = message.id;
    switch (scenario) {
      case 'echo':
        send({ type: 'tool.result', id, result: result(`ran ${message.name}`) });
        break;
      case 'malformed':
        send('not json');
        break;
      case 'oversized':
        out.write('x'.repeat(8 * 1024 * 1024 + 1));
        break;
      case 'unknown-id':
        send({ type: 'tool.result', id: 'other', result: result('x') });
        break;
      case 'duplicate':
        send({ type: 'tool.result', id, result: result('first') });
        send({ type: 'tool.result', id, result: result('second') });
        break;
      case 'job-event':
        send({ type: 'job.event', event: {} });
        break;
      case 'job-started':
        send({ type: 'job.started', jobId: '0123456789abcdef-1' });
        break;
      case 'unknown-type':
        send({ type: 'job.lost', jobId: '0123456789abcdef-1' });
        break;
      case 'relative-path':
        send({ type: 'tool.result', id, result: { ...result('x'), touchedPaths: ['../etc'] } });
        break;
      case 'large-meta':
        send({
          type: 'tool.result',
          id,
          result: { ...result('x'), meta: { blob: 'x'.repeat(70_000) } },
        });
        break;
      case 'extra-field':
        send({ type: 'tool.result', id, result: { ...result('x'), secret: true } });
        break;
      case 'ignore-cancel':
        break;
    }
  }
});
