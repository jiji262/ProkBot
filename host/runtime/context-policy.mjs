export function validateContextPolicy(value = {}) {
  const contextWindowTokens = value.contextWindowTokens ?? 0;
  const summaryThresholdTokens = value.summaryThresholdTokens ?? 0;
  for (const number of [contextWindowTokens, summaryThresholdTokens]) {
    if (!Number.isSafeInteger(number) || number < 0 || number > 100_000_000)
      throw new TypeError('Context limits must be integers between 0 and 100000000');
  }
  if (summaryThresholdTokens && (!contextWindowTokens || summaryThresholdTokens >= contextWindowTokens))
    throw new TypeError('Summary threshold must be below the configured context capacity');
  return { contextWindowTokens, summaryThresholdTokens };
}

export function contextPolicyFor(config, model) {
  const entry = config.policy?.models?.find(item => item.id === model);
  return validateContextPolicy({
    contextWindowTokens: entry?.contextWindowTokens ?? (model === config.model ? config.contextWindowTokens : 0) ?? 0,
    summaryThresholdTokens: entry?.summaryThresholdTokens ?? 0,
  });
}

