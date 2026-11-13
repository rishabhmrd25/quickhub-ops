import { createServer } from 'node:http';
import { createApp } from './app';
import { attachRealtime } from './realtime';
import { startSimulator } from './simulator';
import { Store } from './store';

const PORT = Number(process.env.PORT ?? 4000);
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 120);
const SIMULATOR_ON = process.env.SIMULATOR !== 'off';

const store = new Store();
const server = createServer(createApp(store, { latencyMs: LATENCY_MS }));
const realtime = attachRealtime(server, store);
const stopSimulator = SIMULATOR_ON ? startSimulator(store) : () => {};

server.listen(PORT, () => {
  console.log(`QuickHub API on http://localhost:${PORT}  (simulator ${SIMULATOR_ON ? 'on' : 'off'})`);
});

function shutdown() {
  stopSimulator();
  realtime.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
