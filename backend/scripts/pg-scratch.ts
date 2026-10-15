// Starts/stops a disposable PostgreSQL cluster for running the test suite against a real server.
//   npx ts-node scripts/pg-scratch.ts start|stop [port]
import { existsSync } from 'fs';
import { PgCluster } from '../src/recovery/pgcluster';

const [cmd, portArg] = process.argv.slice(2);
const port = Number(portArg ?? 55440);
const c = new PgCluster({ dataDir: '.dr-work/scratch/data', port });
if (cmd === 'start') {
  if (!existsSync('.dr-work/scratch/data/PG_VERSION')) c.init();
  if (!c.isRunning()) c.start();
  console.log(`TEST_PG_URL=${c.url}`);
} else if (cmd === 'stop') {
  c.stop();
  console.log('stopped');
}
