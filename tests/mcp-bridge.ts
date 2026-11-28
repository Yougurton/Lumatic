import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

let checks = 0;
let failures = 0;
const check = (ok: boolean, name: string, actual: string) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('FAIL', name, actual.slice(0, 200));
  }
};

const script = path.join(process.cwd(), 'scripts', 'lumatic-mcp.mjs');
const stub = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ beat: 42.5, playing: false, stub: true }));
});

function main() {
  return new Promise<void>((resolve) => {
    stub.listen(0, '127.0.0.1', () => resolve());
  }).then(async () => {
    const address = stub.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [script], {
      env: { ...process.env, LUMATIC_AUTOMATION_PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responses = new Map<number, unknown>();
    let stdoutBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line !== '') {
          const message = JSON.parse(line) as { id?: number };
          if (message.id !== undefined) responses.set(message.id, message);
        }
        newline = stdoutBuffer.indexOf('\n');
      }
    });
    const send = (message: unknown) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const response = (id: number) => responses.get(id) as { result?: Record<string, unknown>; error?: { message: string } } | undefined;

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lumatic_state', arguments: {} } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lumatic_seek', arguments: { beat: 12.5 } } });
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'lumatic_logs', arguments: { after: 3 } } });
    send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'lumatic_query', arguments: { from: 10, to: 20, track: 'circle' } } });
    send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'lumatic_scene', arguments: {} } });
    send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'lumatic_capture', arguments: { count: 2 } } });
    send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'lumatic_diff', arguments: { a: 'a.png', b: 'b.png' } } });

    await sleep(2000);
    const init = response(1) as { result?: { serverInfo?: { name?: string } } } | undefined;
    check(init?.result?.serverInfo?.name === 'lumatic', 'initialize answers with the server info', JSON.stringify(init?.result ?? {}));
    const tools = response(2) as { result?: { tools?: { name: string }[] } } | undefined;
    const names = (tools?.result?.tools ?? []).map((tool) => tool.name).join(',');
    check(
      ['lumatic_state', 'lumatic_seek', 'lumatic_screenshot', 'lumatic_open', 'lumatic_preview', 'lumatic_difficulty', 'lumatic_difficulties', 'lumatic_logs', 'lumatic_query', 'lumatic_scene', 'lumatic_capture', 'lumatic_diff'].every((name) => names.includes(name)),
      'tools/list exposes the automation tools',
      names,
    );
    const state = response(3) as { result?: { content?: { text?: string }[] } } | undefined;
    const stateText = state?.result?.content?.[0]?.text ?? '';
    check(stateText.includes('"beat": 42.5'), 'lumatic_state proxies the editor HTTP server', stateText);
    const seek = response(4) as { result?: { content?: { text?: string }[] } } | undefined;
    check((seek?.result?.content?.[0]?.text ?? '').includes('"beat": 42.5'), 'lumatic_seek returns the resulting state', seek?.result?.content?.[0]?.text ?? '');
    for (const [id, name] of [
      [5, 'lumatic_logs'],
      [6, 'lumatic_query'],
      [7, 'lumatic_scene'],
      [9, 'lumatic_diff'],
    ] as const) {
      const answer = response(id) as { result?: { content?: { text?: string }[] } } | undefined;
      check((answer?.result?.content?.[0]?.text ?? '').includes('stub'), `${name} proxies to the automation server`, answer?.result?.content?.[0]?.text ?? 'no answer');
    }
    const capture = response(8) as { result?: { content?: { text?: string }[] }; error?: { message: string } } | undefined;
    check(
      (capture?.result?.content?.[0]?.text ?? '').includes('captures of the editor window') && capture?.error === undefined,
      'lumatic_capture answers gracefully even when the server omits capture data',
      capture?.result?.content?.[0]?.text ?? capture?.error?.message ?? 'no answer',
    );

    child.kill();
    stub.close();
    console.log(`${String(checks - failures)}/${String(checks)} checks passed`);
    if (failures > 0) process.exit(1);
  });
}

void main();
