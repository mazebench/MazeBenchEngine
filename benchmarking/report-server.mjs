// A separately restartable reader: upgrading prices/telemetry never stops agents.
import path from 'node:path';
import { createPlaybackServer } from './playback-server.mjs';

const port = Number(process.env.MAZEBENCH_REPORT_PORT || 8091);
const { server, replays } = createPlaybackServer(path.resolve(import.meta.dirname, '..'), { port, watchVersions: false });
server.listen(port, '127.0.0.1', () => console.log(`MazeBench reports ready on localhost:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  server.close(); server.closeAllConnections(); await replays.close(); process.exit();
});
