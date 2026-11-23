import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

/**
 * A small mDNS look-up (RFC 6762, "legacy unicast": asked from a port of our own, the answers come
 * straight back): the headsets' Android wireless debugging announces itself as
 * `_adb-tls-connect._tcp` (the port to connect to, a new one each time it's switched on) and, while
 * its "pair with a code" window is open, `_adb-tls-pairing._tcp`; adb over Wi-Fi as `_adb._tcp`.
 */

export interface MdnsService {
  type: 'connect' | 'pairing' | 'tcp';
  name: string;
  address: string;
  port: number;
}

const SERVICES: [string, MdnsService['type']][] = [
  ['_adb-tls-connect._tcp.local', 'connect'],
  ['_adb-tls-pairing._tcp.local', 'pairing'],
  ['_adb._tcp.local', 'tcp'],
];

function encodeName(name: string) {
  const parts = name.split('.').filter((part) => part !== '');
  const bytes: number[] = [];
  for (const part of parts) {
    const label = Buffer.from(part, 'utf8');
    bytes.push(label.length, ...label);
  }
  bytes.push(0);
  return bytes;
}

/** One query packet asking for the PTR records of all the services (unicast answers wanted). */
function query() {
  const bytes = [0, 0, 0, 0, 0, SERVICES.length, 0, 0, 0, 0, 0, 0];
  for (const [name] of SERVICES) bytes.push(...encodeName(name), 0, 12, 0x80, 1);
  return Buffer.from(bytes);
}

function readName(packet: Buffer, start: number): [string, number] {
  const labels: string[] = [];
  let offset = start;
  let end = -1;
  for (let guard = 0; guard < 64 && offset < packet.length; guard++) {
    const length = packet[offset]!;
    if (length === 0) {
      offset++;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (end < 0) end = offset + 2;
      offset = ((length & 0x3f) << 8) | packet[offset + 1]!;
      continue;
    }
    labels.push(packet.toString('utf8', offset + 1, offset + 1 + length));
    offset += 1 + length;
  }
  return [labels.join('.'), end < 0 ? offset : end];
}

interface Record {
  name: string;
  type: number;
  data: Buffer;
  at: number;
}

function parse(packet: Buffer): Record[] {
  if (packet.length < 12) return [];
  const questions = packet.readUInt16BE(4);
  const records = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10);
  let offset = 12;
  for (let i = 0; i < questions; i++) offset = readName(packet, offset)[1] + 4;
  const out: Record[] = [];
  for (let i = 0; i < records && offset + 10 <= packet.length; i++) {
    const [name, next] = readName(packet, offset);
    const type = packet.readUInt16BE(next);
    const length = packet.readUInt16BE(next + 8);
    const at = next + 10;
    out.push({ name: name.toLowerCase(), type, data: packet.subarray(at, at + length), at });
    offset = at + length;
  }
  return out;
}

/** The adb services announced on the local networks (asked for `wait` ms). */
export function findAdbServices(wait = 1800): Promise<MdnsService[]> {
  return new Promise((resolve) => {
    const packets: Buffer[] = [];
    const sockets = Object.values(networkInterfaces())
      .flatMap((list) => list ?? [])
      .filter((item) => item.family === 'IPv4' && !item.internal)
      .map((item) => {
        const socket = createSocket({ type: 'udp4', reuseAddr: true });
        socket.on('error', () => socket.close());
        socket.on('message', (packet) => packets.push(packet));
        socket.bind(0, item.address, () => {
          try {
            socket.setMulticastInterface(item.address);
            const packet = query();
            socket.send(packet, 5353, '224.0.0.251');
            // (once more in a moment: the first can get lost)
            setTimeout(() => socket.send(packet, 5353, '224.0.0.251', () => undefined), 500);
          } catch {
            // (that network can't send multicast)
          }
        });
        return socket;
      });
    setTimeout(() => {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // (closed already)
        }
      }
      resolve(servicesFrom(packets));
    }, wait);
  });
}

/** The adb services in mDNS answers. */
export function servicesFrom(packets: Buffer[]): MdnsService[] {
  const records = packets.flatMap((packet) => parse(packet).map((record) => ({ packet, record })));
  // instances (PTR) → their host and port (SRV) → the host's address (A)
  const instances = new Map<string, MdnsService['type']>();
  const srv = new Map<string, { host: string; port: number }>();
  const hosts = new Map<string, string>();
  for (const { packet, record } of records) {
    if (record.type === 12) {
      const kind = SERVICES.find(([name]) => record.name === name.toLowerCase())?.[1];
      if (kind !== undefined) instances.set(readName(packet, record.at)[0].toLowerCase(), kind);
    } else if (record.type === 33 && record.data.length >= 6) {
      srv.set(record.name, { port: record.data.readUInt16BE(4), host: readName(packet, record.at + 6)[0].toLowerCase() });
    } else if (record.type === 1 && record.data.length === 4) {
      hosts.set(record.name, [...record.data].join('.'));
    }
  }
  const out: MdnsService[] = [];
  for (const [instance, type] of instances) {
    const target = srv.get(instance);
    if (target === undefined) continue;
    const address = hosts.get(target.host);
    if (address === undefined) continue;
    out.push({ type, name: instance.split('.')[0] ?? instance, address, port: target.port });
  }
  return out;
}
