'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const STORE_VERSION = 1;

class PerpsPaperStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('A Perps paper-ledger path is required');
    }
    this.filePath = path.resolve(filePath);
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (saved?.version !== STORE_VERSION
        || saved.state?.schemaVersion !== STORE_VERSION
        || !Array.isArray(saved.state.positions)
        || !Array.isArray(saved.state.trades)
        || !Number.isFinite(Number(saved.state.account?.startingCapital))) {
        throw new Error('Saved Perps paper history has an unsupported or invalid format');
      }
      return saved.state;
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
    const write = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, serialized, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tempPath, this.filePath);
    });
    this.writeChain = write.catch(() => {});
    return write;
  }
}

module.exports = { PerpsPaperStore, STORE_VERSION };
