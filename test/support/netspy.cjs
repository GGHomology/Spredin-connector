// Loaded into the connector's process with `node --require` by the tests:
// records every outgoing socket connection (host, port) and every DNS
// lookup to NETSPY_FILE, one JSON line each, so a test can prove the
// connector only ever talks to 127.0.0.1.
'use strict';
const net = require('node:net');
const dns = require('node:dns');
const fs = require('node:fs');

const file = process.env.NETSPY_FILE;
if (file) {
  const record = (rec) => fs.appendFileSync(file, JSON.stringify(rec) + '\n');

  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function spyConnect(...args) {
    // net.createConnection passes its normalised arguments as one array.
    let first = args[0];
    if (Array.isArray(first)) first = first[0];
    if (first && typeof first === 'object') {
      record({ connect: true, host: first.host ?? null, port: first.port ?? null, path: first.path ?? null });
    } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      record({ connect: true, host: typeof args[1] === 'string' ? args[1] : null, port: Number(first) });
    } else {
      record({ connect: true, path: String(first) });
    }
    return connect.apply(this, args);
  };

  const lookup = dns.lookup;
  dns.lookup = function spyLookup(host, ...rest) {
    record({ lookup: host });
    return lookup.call(this, host, ...rest);
  };
}
