// Transfer only new clips and shared geometry. Counts refer to authenticated
// moves, so buffering progress never depends on an estimated replay duration.
const count = value => Number.isSafeInteger(Number(value)) && Number(value)>=0 ? Number(value) : 0;

export function sliceReplayChunk(value, cursor) {
  const movie=value.movie, after=Number(cursor.after ?? -1);
  const append=cursor.epoch===value.epoch && Number.isSafeInteger(after) && after>=0 && after<=value.action_count &&
    count(cursor.templates)<=movie.templates.length && count(cursor.layouts)<=movie.layouts.length;
  const from=append?after+1:0, templatesFrom=append?count(cursor.templates):0, layoutsFrom=append?count(cursor.layouts):0;
  const end=Math.min(value.action_count,from+cursor.limit-1), clips=movie.clips.slice(from,end+1);
  const duration=movie.clips[end]?.start+movie.clips[end]?.duration || 0;
  return {epoch:value.epoch,action_count:end,total_action_count:value.total_action_count??value.action_count,
    complete:end>=(value.total_action_count??value.action_count),observation_mode:value.observation_mode,
    ...(append?{}:{world:value.world}),from,templatesFrom,layoutsFrom,
    movie:{startRoom:movie.startRoom,duration,clips,templates:movie.templates.slice(templatesFrom),
      layouts:movie.layouts.slice(layoutsFrom),visits:movie.visits.filter(event=>event.at<=duration),gems:movie.gems.filter(event=>event.at<=duration)}};
}

export function appendReplayChunk(previous, epoch, chunk) {
  if(chunk.from===0)return chunk.movie;
  if(!previous || epoch!==chunk.epoch || previous.clips.length!==chunk.from ||
    previous.templates.length!==chunk.templatesFrom || previous.layouts.length!==chunk.layoutsFrom) {
    throw new Error('Replay buffer changed. Reload the replay to continue.');
  }
  return {...chunk.movie,clips:previous.clips.concat(chunk.movie.clips),
    templates:previous.templates.concat(chunk.movie.templates),layouts:previous.layouts.concat(chunk.movie.layouts)};
}

export function replayBufferTime(movie, position) {
  const index=Math.max(0,Math.floor(position)),clip=movie.clips[index];
  return clip?clip.start+clip.duration*(position-index):movie.duration;
}
