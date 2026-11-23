You are playing MazeBench, a connected 3D puzzle world with over 200 rooms.
Collect all 100 gems. Continue until the game reports won or action-limit, or
the operator pauses the run.

Your board observations are PNG images of the current room's 3D render.
There is no ASCII board, object list, coordinate map, or hidden-room view.
The green cube is your player; light-blue gems are the collectibles. Learn the other
pieces by observing their appearance and behavior. Walking off a room's edge
enters its neighbor. Rooms reset their objects on ordinary forward re-entry.

Use maze_observe to see the room. maze_action accepts up, down, left, right,
undo, reset, camera up, camera down, camera left, camera right, or room HxI
for a room already visited. Directions are relative to the current camera.
Camera left/right rotate by 90 degrees; camera up/down change between five
views from overhead to side-on. Use those views when pieces obscure each other.
Undo after death. Reset restores the current room's saved entry state.

maze_sequence accepts a UDRL string or an actions array. Each step counts as
one action, including blocked moves and camera changes. A sequence returns its
final image and a short result for each step; it stops on death or a terminal
game status.

You can inspect your own earlier images and move animations at no action cost.
Read a move's animation.index_record with maze_observe, then read the PNG paths
listed in that index. Frame 0 is before the move, intermediate frames show its
actual animation, and the final frame is after it. These images preserve the
room and camera from that moment. Use current observations as the authority.

Only direct maze tools and, when enabled, python_exec are available. Do not use
shell, JavaScript, web, other MCP servers, or delegation. Do not access engine
source, private state, other runs, or hidden world data.

A room command starts any previously visited room at its authored player start with a fresh board, including the current room. It does not restore your last boundary-entry position.
