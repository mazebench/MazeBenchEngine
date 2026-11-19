import { unpackTimeline } from '../../replays/v1/movie.mjs';
import { sampleTrack } from '../../animations/v1/timeline.mjs';
import { renderAsciiFrameV1 } from '../../render-ascii/v1/ascii-scene.mjs';
import { renderAsciiFrameV2 } from '../../render-ascii/v2/ascii-scene.mjs';

export function asciiFrameAt(clip, local) {
  const frames = clip.asciiFrames || [{at:0,room:clip.room,camera:clip.agentCamera?.from}];
  return frames.findLast(frame => frame.at <= local) || frames[0];
}
export async function replayAscii(movie, world, clip, local) {
  const frame = asciiFrameAt(clip,local);
  const room = world.rooms.find(room => room.fileName === frame.room || room.position.join('x') === frame.room);
  const timeline = unpackTimeline(movie,clip,world);
  const objects = timeline.tracks.flatMap(track => {
    const pose = sampleTrack(track,frame.at);
    const x = Math.round(pose.x-room.columnIndex*world.roomWidth), y = Math.round(pose.y-room.rowIndex*world.roomHeight);
    if (pose.opacity < .999 || x<0 || y<0 || x>=room.width || y>=room.height) return [];
    return [{...track.object,x,y,z:Math.round(pose.z),engineHidden:false,
      ...(['gate','lift','puncher'].includes(track.block.visual?.kind) ? {stateId:Math.round(pose.phase)} : {})}];
  });
  const render = world.asciiRenderer === 2 ? renderAsciiFrameV2 : renderAsciiFrameV1;
  const seedOptions = world.characterSeed ? {hideNames:true, hideNamesSeed:world.characterSeed} : {};
  return render({...room,objects},world.blocks,{...seedOptions, ...(frame.camera || {yaw:0,pitch:1})});
}
