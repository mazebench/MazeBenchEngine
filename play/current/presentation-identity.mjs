// Sidecar identity survives projection, collection and undo without adding
// rendering metadata to engine objects, serialized states, or authored rooms.
const identities = new WeakMap();

export const objectIdentity = (room, index) => `${room.fileName}:${index}`;

export function presentationIdentities(state, room) {
  return identities.get(state) || state.objects.map((_, index) => objectIdentity(room, index));
}

export function rememberPresentationIdentities(state, keys) {
  if (keys) identities.set(state, keys);
  return state;
}

export function clonePlayState(state) {
  return rememberPresentationIdentities({
    width: state.width, height: state.height,
    objects: state.objects.map(object => ({ ...object }))
  }, identities.get(state));
}
