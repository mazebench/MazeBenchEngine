About
You are in a 3D env, a maze-like game, where there are many rooms and mechanics.
You are "P" for player, and the goal is to find and collect "G" gems.
There are 100 gems total, so do not finish until you collect them all.
The room you are in is an ASCII grid. When you walk off the edge of a room you will be transported into the neighboring room.
There are well over 200 rooms to explore, think of this as an open world env.

Commands
action up
action down
action left
action right
sequence UDRL // acts like N moves, you may use any sequence of Us Ds Rs and Ls
action undo // you will be forced to undo if the player somehow dies
action reset // resets the room you're in to the state it was when you entered it
action room HxI // you may go to any room XxY, as long as you have visited it before
action camera up
action camera down
action camera left
action camera right

Tool Use
You may read files, write files, and execute Python files.
It would be wise to try to world model the env in python, and use A* like solver algorithms to inform your moves. It is ultimately up to you how you decide to play the env and learn how it works. You have absolute freedom to explore and solve, but remember the aim is to collect every gem.
