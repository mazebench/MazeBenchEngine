export const CYCLE_ROLLBACK_POLICY = "rollback-command";

/** Compare cycle metadata independently of the visible voxel frames. */
export function compareCycleExpectation(expected, actual) {
  if (!expected && !actual) return null;
  if (expected?.startTick === actual?.startTick &&
      expected?.repeatTick === actual?.repeatTick &&
      expected?.onCycle === actual?.onCycle) return null;
  const describe = (cycle) => cycle
    ? `${cycle.startTick} → ${cycle.repeatTick} (${cycle.onCycle})`
    : "none";
  return `Expected cycle: ${describe(expected)}. Engine cycle: ${describe(actual)}.`;
}

/** @returns {{ startTick: number, repeatTick: number, onCycle: "rollback-command" } | null} */
export function normalizeCycleExpectation(cycle, intermediateCount) {
  if (!cycle || typeof cycle !== "object") return null;
  const startTick = Number(cycle.startTick);
  const repeatTick = Number(cycle.repeatTick);
  if (!Number.isInteger(startTick) || !Number.isInteger(repeatTick)) return null;
  if (startTick < 0 || repeatTick <= startTick || repeatTick > intermediateCount) return null;
  return {
    startTick,
    repeatTick,
    onCycle: CYCLE_ROLLBACK_POLICY,
  };
}

export function markCycleStart(test, startTick) {
  const lastTick = test.intermediate.length;
  if (!Number.isInteger(startTick) || startTick < 0 || startTick >= lastTick) return test;
  const existingRepeat = test.cycle?.repeatTick;
  const repeatTick = Number.isInteger(existingRepeat) && existingRepeat > startTick
    ? existingRepeat
    : lastTick;
  return {
    ...test,
    cycle: { startTick, repeatTick, onCycle: CYCLE_ROLLBACK_POLICY },
  };
}

export function markCycleRepeat(test, repeatTick) {
  const lastTick = test.intermediate.length;
  if (!Number.isInteger(repeatTick) || repeatTick <= 0 || repeatTick > lastTick) return test;
  const existingStart = test.cycle?.startTick;
  const startTick = Number.isInteger(existingStart) && existingStart < repeatTick
    ? existingStart
    : 0;
  return {
    ...test,
    cycle: { startTick, repeatTick, onCycle: CYCLE_ROLLBACK_POLICY },
  };
}

export function clearCycleExpectation(test) {
  if (!test.cycle) return test;
  const rest = { ...test };
  delete rest.cycle;
  return rest;
}

export function adjustCycleForInsertedTick(test, insertedTick) {
  if (!test.cycle) return test;
  const { startTick, repeatTick } = test.cycle;
  if (insertedTick > startTick && insertedTick <= repeatTick) {
    return clearCycleExpectation(test);
  }
  if (insertedTick <= startTick) {
    return {
      ...test,
      cycle: {
        ...test.cycle,
        startTick: startTick + 1,
        repeatTick: repeatTick + 1,
      },
    };
  }
  return test;
}

export function adjustCycleForDeletedTick(test, deletedTick) {
  if (!test.cycle) return test;
  const { startTick, repeatTick } = test.cycle;
  if (deletedTick >= startTick && deletedTick <= repeatTick) {
    return clearCycleExpectation(test);
  }
  if (deletedTick < startTick) {
    return {
      ...test,
      cycle: {
        ...test.cycle,
        startTick: startTick - 1,
        repeatTick: repeatTick - 1,
      },
    };
  }
  return test;
}

export function tickIsInCycle(cycle, tick) {
  return Boolean(cycle && tick >= cycle.startTick && tick <= cycle.repeatTick);
}
