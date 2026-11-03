'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

class JsonStateStore {
  constructor(directory, { filename = 'live-order-ledger.json' } = {}) {
    if (!directory) throw new Error('A persistent state directory is required');
    this.directory = directory;
    this.filePath = path.join(directory, filename);
    this.durable = true;
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const document = JSON.parse(raw);
      if (document?.version !== 1 || !Array.isArray(document.orders) || !Array.isArray(document.entryKeys)) {
        throw new Error('Persisted live-order ledger has an unsupported or invalid format');
      }
      return document;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  save(document) {
    const next = this.writeChain.then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tempPath, this.filePath);
    });
    this.writeChain = next.catch(() => {});
    return next;
  }
}

module.exports = { JsonStateStore };
