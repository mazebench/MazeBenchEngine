export function rollingNovelty(values, windowSize) {
  const states = values || [];
  let novelCount = 0;
  return states.map((value, index) => {
    novelCount += Number(Boolean(value));
    if (index >= windowSize) novelCount -= Number(Boolean(states[index - windowSize]));
    // State zero is the initial, novel board. There are no samples before it.
    return novelCount / Math.min(index + 1, windowSize);
  });
}
