/** @typedef {{ yaw: number, tilt: number }} PreviewCamera */
/** @typedef {{ key: string, testId: string, frameIndex: number, generation: number }} PreviewJob */
/** @typedef {{ dataUrl: string, generation: number }} PreviewImage */
/** @typedef {{ camera: PreviewCamera, generation: number, queue: PreviewJob[], lastJob: PreviewJob | null, previews: Record<string, PreviewImage> }} PreviewState */
/** @typedef {{ type: 'camera', key: string } | { type: 'reset' } | ({ type: 'request' } & PreviewJob) | { type: 'complete', key: string, generation: number, dataUrl: string } PreviewAction */

export const DEFAULT_PREVIEW_CAMERA = Object.freeze({ yaw: 0, tilt: 0.22 });

/** @param {PreviewCamera} camera @param {string} key @returns {PreviewCamera} */
export function stepPreviewCamera(camera, key) {
  const normalized = key.toLowerCase();
  let { yaw, tilt } = camera;
  if (normalized === 'a' || normalized === 'd') {
    const turns = Math.round(yaw / (Math.PI / 2));
    yaw = ((turns + (normalized === 'a' ? -1 : 1) + 4) % 4) * Math.PI / 2;
  } else if (normalized === 'w' || normalized === 's') {
    tilt = Math.max(0, Math.min(Math.PI, tilt + (normalized === 'w' ? -1 : 1) * Math.PI / 12));
  } else return camera;
  return yaw === camera.yaw && tilt === camera.tilt ? camera : { yaw, tilt };
}

/** @returns {PreviewState} */
export function createSuitePreviewState() {
  return { camera: DEFAULT_PREVIEW_CAMERA, generation: 0, queue: [], lastJob: null, previews: {} };
}

/**
 * One shared renderer works through visible cards. Camera changes cancel the old
 * queue; late snapshots cannot overwrite the new angle. Keep the last picture
 * on screen until its replacement arrives, without retaining an angle history.
 * @param {PreviewState} state
 * @param {PreviewAction} action
 * @returns {PreviewState}
 */
export function suitePreviewReducer(state, action) {
  if (action.type === 'camera' || action.type === 'reset') {
    const camera = action.type === 'reset' ? DEFAULT_PREVIEW_CAMERA : stepPreviewCamera(state.camera, action.key);
    if (camera.yaw === state.camera.yaw && camera.tilt === state.camera.tilt) return state;
    return { ...state, camera, generation: state.generation + 1, queue: [] };
  }
  if (action.generation !== state.generation) return state;
  if (action.type === 'request') {
    if (state.previews[action.key]?.generation === state.generation || state.queue.some(job => job.key === action.key)) return state;
    return { ...state, queue: [...state.queue, { key: action.key, testId: action.testId, frameIndex: action.frameIndex, generation: action.generation }] };
  }
  if (!state.queue.some(job => job.key === action.key)) return state;
  return {
    ...state,
    lastJob: state.queue.find(job => job.key === action.key) ?? state.lastJob,
    previews: { ...state.previews, [action.key]: { dataUrl: action.dataUrl, generation: action.generation } },
    queue: state.queue.filter(job => job.key !== action.key),
  };
}
