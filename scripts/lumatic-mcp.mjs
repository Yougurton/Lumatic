#!/usr/bin/env node
// Lumatic MCP bridge: exposes the running Lumatic editor (started with --automation) as MCP tools.
// Dependency-free: MCP speaks newline-delimited JSON-RPC 2.0 over stdio, which is implemented
// here by hand; the editor side is the local HTTP server from electron/automation.ts.

import http from 'node:http';

const port = Number(process.env.LUMATIC_AUTOMATION_PORT ?? 9315);
const base = `http://127.0.0.1:${port}`;

const TOOLS = [
  {
    name: 'lumatic_state',
    description: 'Lumatic editor state: open map, difficulty, current beat, playing, preview detached.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'lumatic_seek',
    description: 'Seek the editor to a beat and return the new state.',
    inputSchema: {
      type: 'object',
      properties: { beat: { type: 'number', description: 'Song position in beats (BPM-time).' } },
      required: ['beat'],
      additionalProperties: false,
    },
  },
  {
    name: 'lumatic_play',
    description: 'Start playback.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'lumatic_pause',
    description: 'Pause playback.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'lumatic_open',
    description: 'Open a map folder (the difficulty the editor remembers for it opens by itself).',
    inputSchema: {
      type: 'object',
      properties: { folder: { type: 'string', description: 'Absolute path to the map folder (with Info.dat).' } },
      required: ['folder'],
      additionalProperties: false,
    },
  },
  {
    name: 'lumatic_difficulties',
    description: 'List the open map difficulties (key + label).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'lumatic_difficulty',
    description: 'Switch the open map to a difficulty by key (see lumatic_difficulties), returns the new state.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Difficulty key, e.g. Standard/ExpertPlus/ExpertPlusStandard.dat.' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'lumatic_preview',
    description: 'Detach (true) or re-attach (false) the 3D preview window.',
    inputSchema: {
      type: 'object',
      properties: { detach: { type: 'boolean' } },
      required: ['detach'],
      additionalProperties: false,
    },
  },
  {
    name: 'lumatic_screenshot',
    description: 'PNG screenshot of the editor window or of the detached 3D preview window.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', enum: ['editor', 'preview'], description: 'Defaults to editor.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'lumatic_logs',
    description: 'The editor page console log ring buffer (renderer logs never reach the process stdout). Returns entries newer than `after` (a seq from a previous call); clear: true resets the buffer. Each entry carries the beat it was logged at.',
    inputSchema: {
      type: 'object',
      properties: {
        after: { type: 'number', description: 'Only entries with seq > after. 0 = everything kept.' },
        clear: { type: 'boolean', description: 'Drop the buffered entries after reading.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'lumatic_query',
    description: 'Query the open difficulty over a beat window: Chroma animations (AnimateTrack, with the last point value of each present property), basic light events, and parent assignments. Filters by track substring.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'number', description: 'Beat window start (inclusive).' },
        to: { type: 'number', description: 'Beat window end (inclusive).' },
        track: { type: 'string', description: 'Track name substring filter (case-insensitive), e.g. "circle".' },
        kind: { type: 'string', enum: ['all', 'animation', 'event', 'parent'], description: 'Defaults to all.' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'lumatic_scene',
    description: 'Per-track visibility snapshot of the map\'s Chroma geometry at the current state: visible/parked counts and a world position sample of the first visible target. Sorted by visible count (parked-only tracks are summarized, not listed).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'lumatic_capture',
    description: 'Capture a series of screenshots of the editor or 3D preview window (PNG files + raw frames kept server-side) and report how much consecutive frames differ. Captures at the CURRENT editor state — seek first. Use it to measure flicker: capture a series at a paused beat to learn the noise floor (the editor UI clock and bloom breathing give small nonzero diffs), then compare the suspect segment — sustained elevated diffs localized on geometry mean flicker.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Frames to capture. 1–40, default 8.' },
        intervalMs: { type: 'number', description: 'Pause between frames in ms. 30–5000, default 250.' },
        target: { type: 'string', enum: ['editor', 'preview'], description: 'Defaults to editor.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'lumatic_diff',
    description: 'Compare two captures from lumatic_capture by file name: mean abs diff (0-255 scale per pixel), changed pixel count/ratio and the changed-region bounding box.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'File name of the first capture (from lumatic_capture files).' },
        b: { type: 'string', description: 'File name of the second capture.' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
];

function request(path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      url,
      {
        method,
        headers: payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 10000,
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`invalid JSON from Lumatic: ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('Lumatic did not answer in 10 seconds'));
    });
    req.on('error', (error) => reject(error));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function callTool(name, args) {
  switch (name) {
    case 'lumatic_state':
      return { text: JSON.stringify(await request('/state'), null, 2) };
    case 'lumatic_seek': {
      const state = await request('/seek', { method: 'POST', body: { beat: Number(args.beat) } });
      return { text: JSON.stringify(state, null, 2) };
    }
    case 'lumatic_play':
      return { text: JSON.stringify(await request('/play', { method: 'POST', body: {} })) };
    case 'lumatic_pause':
      return { text: JSON.stringify(await request('/pause', { method: 'POST', body: {} })) };
    case 'lumatic_open': {
      const result = await request('/open', { method: 'POST', body: { folder: String(args.folder) } });
      return { text: `${JSON.stringify(result)} — wait for the difficulty strip to show the map name before seeking.` };
    }
    case 'lumatic_difficulties':
      return { text: JSON.stringify(await request('/difficulties'), null, 2) };
    case 'lumatic_difficulty': {
      const state = await request('/difficulty', { method: 'POST', body: { key: String(args.key) } });
      return { text: JSON.stringify(state, null, 2) };
    }
    case 'lumatic_preview':
      return { text: JSON.stringify(await request('/preview', { method: 'POST', body: { detach: args.detach === true } })) };
    case 'lumatic_screenshot': {
      const target = args.target === 'preview' ? 'preview' : 'editor';
      const shot = await request(`/screenshot?target=${target}`);
      return {
        content: [
          { type: 'image', data: shot.base64, mimeType: 'image/png' },
          { type: 'text', text: `${target} window, ${shot.format}, base64 length ${shot.base64.length}` },
        ],
      };
    }
    case 'lumatic_logs': {
      const params = new URLSearchParams();
      if (args.after !== undefined) params.set('after', String(Number(args.after)));
      if (args.clear === true) params.set('clear', '1');
      const suffix = params.toString() === '' ? '' : `?${params.toString()}`;
      return { text: JSON.stringify(await request(`/logs${suffix}`), null, 2) };
    }
    case 'lumatic_query': {
      const params = new URLSearchParams();
      params.set('from', String(Number(args.from)));
      params.set('to', String(Number(args.to)));
      if (typeof args.track === 'string' && args.track !== '') params.set('track', args.track);
      if (typeof args.kind === 'string' && args.kind !== '' && args.kind !== 'all') params.set('kind', args.kind);
      return { text: JSON.stringify(await request(`/query?${params.toString()}`), null, 2) };
    }
    case 'lumatic_scene':
      return { text: JSON.stringify(await request('/scene'), null, 2) };
    case 'lumatic_capture': {
      const result = await request('/capture', {
        method: 'POST',
        body: {
          count: args.count === undefined ? 8 : Number(args.count),
          intervalMs: args.intervalMs === undefined ? 250 : Number(args.intervalMs),
          target: args.target === 'preview' ? 'preview' : 'editor',
        },
      });
      if (result !== null && typeof result === 'object' && 'error' in result) throw new Error(String(result.error));
      const files = Array.isArray(result.files) ? result.files : [];
      const summary = files.map((file, index) => {
        const diff = (Array.isArray(result.diffs) ? result.diffs : []).find((entry) => entry.index === index + 1);
        return `${file}${diff === undefined ? '' : `  diff vs prev: mean ${diff.meanDiff}, changed ${diff.changedPixels} px (${Math.round((diff.changedRatio ?? 0) * 100) / 100}%)`}`;
      });
      return {
        content: [
          { type: 'text', text: `${files.length} captures of the ${result.target ?? 'editor'} window (${result.width ?? '?'}x${result.height ?? '?'}) in ${result.dir ?? '(unavailable)'}\n${summary.join('\n')}` },
        ],
      };
    }
    case 'lumatic_diff':
      return { text: JSON.stringify(await request('/diff', { method: 'POST', body: { a: String(args.a), b: String(args.b) } }), null, 2) };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line !== '') handleMessage(JSON.parse(line));
    newline = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));

function handleMessage(message) {
  if (message === null || typeof message !== 'object' || message.id === undefined) return; // notification
  const { id, method, params } = message;
  void (async () => {
    try {
      switch (method) {
        case 'initialize':
          send({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'lumatic', title: 'Lumatic editor bridge', version: '0.1.0' },
            },
          });
          return;
        case 'notifications/initialized':
          return;
        case 'ping':
          send({ jsonrpc: '2.0', id, result: {} });
          return;
        case 'tools/list':
          send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
          return;
        case 'tools/call': {
          const name = String(params?.name ?? '');
          const args = params?.arguments ?? {};
          try {
            const result = await callTool(name, args);
            send({ jsonrpc: '2.0', id, result: { content: result.content ?? [{ type: 'text', text: result.text }], isError: false } });
          } catch (error) {
            send({
              jsonrpc: '2.0',
              id,
              result: { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true },
            });
          }
          return;
        }
        default:
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } });
      }
    } catch (error) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
    }
  })();
}
