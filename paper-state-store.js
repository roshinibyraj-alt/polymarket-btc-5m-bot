'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const STORE_VERSION = 1;

class PaperStateStore {
  constructor(filePath) {
    if (!filePath) throw new Error('A paper-state file path is required');
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const document = JSON.parse(raw);
      if (document?.version !== STORE_VERSION
        || document.state?.schemaVersion !== STORE_VERSION
        || !Array.isArray(document.state.positions)
        || !Number.isFinite(Number(document.state.cash))) {
        throw new Error('Persisted paper portfolio has an unsupported or invalid format');
      }
      return document.state;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  save(state) {
    const serialized = JSON.stringify({
      version: STORE_VERSION,
      savedAt: new Date().toISOString(),
      state,
    });
    const next = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, serialized, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tempPath, this.filePath);
    });
    this.writeChain = next.catch(() => {});
    return next;
  }
}

function paperStateFilePath(env = process.env, projectDirectory = __dirname) {
  if (env.PAPER_STATE_FILE) return env.PAPER_STATE_FILE;
  const directory = env.PAPER_STATE_DIR || env.BOT_STATE_DIR
    || (env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID
      ? '/data'
      : path.join(projectDirectory, '.data'));
  return path.join(directory, 'pressure-paper-state.json');
}

module.exports = { PaperStateStore, paperStateFilePath };
