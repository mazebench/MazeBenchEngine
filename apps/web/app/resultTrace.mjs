export function shouldShowResultComparison(result) {
  return result?.pass === false;
}

export function traceFrameLabel(index, expectedCount) {
  if (index === 0) return "Start";
  if (index === expectedCount - 1) return `Final · tick ${index}`;
  if (index >= expectedCount) return `Extra engine tick ${index}`;
  return `Tick ${index}`;
}
