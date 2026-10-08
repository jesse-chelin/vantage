'use strict';

// Model pruning intelligence: which models are used, which are cold, and how
// much space deleting them would actually free.

function lastSegment(name) {
  const value = String(name || '');
  return value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
}

function baseOf(name) {
  return lastSegment(name).split(':')[0];
}

function insights(inventory, usage = {}) {
  const models = (inventory && inventory.ollama && inventory.ollama.models) || [];
  const oc = (inventory && inventory.agentStack && inventory.agentStack.openclaw) || {};
  const routing = [oc.primaryModel, oc.utilityModel, oc.subagentModel, oc.imageModel, ...(oc.fallbackModels || [])].filter(Boolean);
  const usedBases = new Set([...routing, ...Object.keys(oc.aliasModels || {})].map(baseOf));

  const now = Date.now();
  const COLD_MS = 7 * 24 * 60 * 60 * 1000;

  const digestCount = new Map();
  for (const model of models) digestCount.set(model.digest, (digestCount.get(model.digest) || 0) + 1);

  const enriched = models.map((model) => {
    const base = baseOf(model.name);
    const used = usedBases.has(base);
    const record = usage[model.name] || null;
    const lastLoaded = record ? record.lastLoaded : null;
    const loads = record ? record.loads : 0;
    const cold = !used && (!lastLoaded || now - lastLoaded > COLD_MS);
    const shared = (digestCount.get(model.digest) || 0) > 1;
    return {
      name: model.name,
      base,
      sizeBytes: model.sizeBytes || 0,
      digest: model.digest,
      capabilities: model.capabilities || [],
      parameterSize: model.parameterSize || null,
      quantization: model.quantization || null,
      modifiedAt: model.modifiedAt || null,
      used,
      lastLoaded,
      loads,
      cold,
      shared,
      freesIfDeleted: shared ? 0 : model.sizeBytes || 0,
      recommended: cold && !used,
    };
  });

  // Space is only reclaimed when every tag of a blob is removed.
  const byDigest = new Map();
  for (const model of enriched) {
    if (!byDigest.has(model.digest)) byDigest.set(model.digest, []);
    byDigest.get(model.digest).push(model);
  }
  let totalReclaimableBytes = 0;
  for (const group of byDigest.values()) {
    if (group.every((model) => model.recommended)) totalReclaimableBytes += group[0].sizeBytes || 0;
  }

  const recommended = enriched
    .filter((model) => model.recommended)
    .sort((a, b) => b.freesIfDeleted - a.freesIfDeleted || b.sizeBytes - a.sizeBytes);

  return {
    models: enriched,
    recommended,
    totalReclaimableBytes,
    coldCount: enriched.filter((model) => model.cold).length,
    usedCount: enriched.filter((model) => model.used).length,
    modelCount: enriched.length,
    agentModels: [...usedBases],
  };
}

module.exports = { insights, baseOf };
