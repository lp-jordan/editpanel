const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function fileChecksum(filePath) {
  const buffer = fs.readFileSync(filePath);
  return sha256(buffer);
}

function walkFiles(rootPath) {
  const out = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(current).map(name => path.join(current, name));
      entries.sort();
      stack.push(...entries.reverse());
      continue;
    }
    if (stat.isFile()) {
      out.push(current);
    }
  }
  return out.sort();
}

function sourceSignature(sourcePath) {
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved)) {
    return { path: resolved, exists: false };
  }

  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    return {
      path: resolved,
      exists: true,
      type: 'file',
      size: stat.size,
      mtime_ms: Number(stat.mtimeMs || 0),
      checksum: fileChecksum(resolved)
    };
  }

  if (stat.isDirectory()) {
    const files = walkFiles(resolved).map(file => {
      const childStat = fs.statSync(file);
      return {
        path: path.relative(resolved, file),
        size: childStat.size,
        mtime_ms: Number(childStat.mtimeMs || 0),
        checksum: fileChecksum(file)
      };
    });

    return {
      path: resolved,
      exists: true,
      type: 'directory',
      file_count: files.length,
      files
    };
  }

  return {
    path: resolved,
    exists: true,
    type: 'other',
    size: stat.size,
    mtime_ms: Number(stat.mtimeMs || 0)
  };
}

function detectFfmpegVersion() {
  try {
    const stdout = execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { encoding: 'utf8' });
    const line = String(stdout || '').split(/\r?\n/).find(Boolean) || '';
    return line.trim();
  } catch (_error) {
    return 'unknown';
  }
}

function resolveToolVersions(explicit = {}) {
  return {
    ffmpeg: explicit.ffmpeg || detectFfmpegVersion(),
    transcribe: explicit.transcribe || (explicit.engine || 'unknown'),
    resolve: explicit.resolve || process.env.RESOLVE_WORKER_VERSION || 'unknown'
  };
}

class StepCacheStore {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.state = this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      return { entries: {} };
    }
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (_error) {
      return { entries: {} };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  get(fingerprint, ttlMs = 0) {
    const entry = this.state.entries[fingerprint];
    if (!entry) return null;
    if (ttlMs > 0 && Date.now() - Number(entry.created_at || 0) > ttlMs) return null;
    return entry;
  }

  set(fingerprint, metadata) {
    this.state.entries[fingerprint] = {
      created_at: Date.now(),
      ...metadata
    };
    this.save();
  }

  invalidate(fingerprint = null) {
    if (!fingerprint) {
      this.state.entries = {};
    } else {
      delete this.state.entries[fingerprint];
    }
    this.save();
  }
}

function buildStepFingerprint(step, toolVersions = {}) {
  const normalizedPayload = step.payload || {};
  const candidateSources = [
    normalizedPayload.folder_path,
    normalizedPayload.path,
    normalizedPayload.file,
    normalizedPayload.source
  ].filter(Boolean);

  const sourceSignatures = candidateSources.map(source => sourceSignature(source));
  const versions = resolveToolVersions({ ...toolVersions, engine: normalizedPayload.engine });

  return {
    digest: sha256(stableStringify({
      command: step.cmd,
      inputs: normalizedPayload,
      sources: sourceSignatures,
      tool_versions: versions
    })),
    sourceSignatures,
    toolVersions: versions
  };
}

function validateOutputContract(step, output) {
  const contract = step.output_contract || { type: 'non_null' };

  if (contract.type === 'non_null') {
    return output !== null && output !== undefined;
  }

  if (contract.type === 'transcribe_output') {
    if (!output || typeof output !== 'object') return false;
    if (!Array.isArray(output.outputs) || output.outputs.length === 0) return false;

    for (const entry of output.outputs) {
      if (!entry || !entry.file || !Array.isArray(entry.output_paths) || entry.output_paths.length === 0) {
        return false;
      }
      if (!fs.existsSync(entry.file)) return false;
      for (const outputPath of entry.output_paths) {
        if (!fs.existsSync(outputPath)) return false;
        const stat = fs.statSync(outputPath);
        if (!stat.isFile() || stat.size <= 0) return false;
      }
    }

    return true;
  }

  return true;
}

module.exports = {
  StepCacheStore,
  buildStepFingerprint,
  validateOutputContract
};
