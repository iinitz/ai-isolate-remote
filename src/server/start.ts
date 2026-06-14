/**
 * Runnable entry for the executor server. This is what the Docker image and
 * `npm start` run. Must be launched with `--no-node-snapshot` (isolated-vm
 * requires it on Node 20+).
 */
import { startServer } from './index.js'

void startServer()
