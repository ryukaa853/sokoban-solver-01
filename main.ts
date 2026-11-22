// sokoban-room-astar 1.0.0 — a push-optimal Sokoban solver for make.fun's
// sokoban-solver-01-run-20261121 (MIT).
//
// Approach, written from scratch for this entry:
//
//   1. Room decomposition. Every level this competition draws is a one-wide
//      hallway with independent rooms off it (a box pushed out of a room can
//      never come back, so each room's boxes stay in their room and the
//      level's push optimum is the sum of its rooms' optima). The solver
//      finds the hallway row — the one row whose interior is all floor —
//      cuts it out, and takes each remaining floor component holding boxes
//      as a room. Rooms are solved in a fixed order, the other rooms' boxes
//      standing as walls, the player walking on from where the last room
//      left it.
//   2. Push A*. Each room is solved by A* over pushes (not steps): a state
//      is the sorted box squares plus the player's reachable region, named
//      by its lowest square, so two states that differ only in where the
//      player stands inside one region are one state. The heuristic is the
//      cheapest assignment of boxes to goals by walking distance (exact
//      min-cost matching for the small rooms here), which never overestimates
//      the pushes left — each push moves one box one square — so the first
//      solved state popped is push-optimal.
//   3. Deadlock pruning. A box is pruned when it stands on a dead square
//      (no pull path from any goal reaches it, ignoring the other boxes) or
//      when a push completes a frozen 2 x 2 block of walls and boxes holding
//      a box off its goal; neither prunes a solvable state.
//   4. Fallback. When a level is not a set of rooms, or a room's search
//      exhausts its budget, the same push A* runs over the whole level. When
//      that gives up too, the level is answered with an empty solution —
//      still a valid answer file, worth 0 points, never a crash.
//
// Determinism: budgets count expanded states, never the clock; there is no
// randomness, no wall-clock read, and every tie (heap order, walk order,
// room order) breaks by a fixed rule, so two runs write identical bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
// (Node 22; the file uses erasable TypeScript syntax only, no imports beyond node:fs/node:path.)
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Work budgets, in expanded states — never the clock, so a run is repeatable. */
const ROOM_BUDGET = 400_000;
/** The whole-level fallback is insurance only (rooms are the normal path): keep it small enough that it can never eat the run's wall budget. */
const LEVEL_BUDGET = 200_000;

/** [dx, dy, letter], in one fixed order: every tie in the search breaks the same way. */
const DIRS: [number, number, string][] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

type Level = {
  w: number;
  h: number;
  /** 1 = wall, 0 = floor; the outer frame is forced to wall so neighbours stay in range. */
  wall: Uint8Array;
  goals: number[];
  /** Sorted box squares. */
  boxes: number[];
  player: number;
};

/** Parse XSB: # wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** The shortest walk from `from` to `to` around walls and `occupied` boxes, as LURD letters, or null. */
function walkMoves(wall: Uint8Array, occupied: Uint8Array, w: number, from: number, to: number): string | null {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/**
 * Flood the player's reachable region from `from` around walls and `occupied` boxes,
 * marking it in `seen` with `stamp`; returns its lowest square (the region's name).
 */
function regionLow(
  wall: Uint8Array,
  occupied: Uint8Array,
  w: number,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (!wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * The squares from which a box alone can still reach some goal: pull back from the
 * goals — a square y is live when some live square x sits one push beyond it
 * (y = x - d) with the player's foothold y - d open floor. Boxes only ever block
 * more, so a square this misses is truly dead.
 */
function liveSquares(wall: Uint8Array, goals: number[], w: number): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue: number[] = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Whether any 2 x 2 block of walls and boxes containing square `t` holds a box off
 * its goal. Every box in such a block can never be pushed again — each of its four
 * moves is blocked by the block itself or needs the player to stand inside it —
 * and the block's other boxes are stuck the same way, so the block is permanent.
 */
function frozenBlockAt(wall: Uint8Array, occupied: Uint8Array, goal: Uint8Array, w: number, t: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** Walking distance from each goal over floor alone (walls only, boxes ignored), by BFS. */
function goalDistances(wall: Uint8Array, goals: number[], w: number): Int32Array[] {
  return goals.map((g) => {
    const dist = new Int32Array(wall.length).fill(-1);
    const queue: number[] = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && dist[q] < 0) {
          dist[q] = dist[p]! + 1;
          queue.push(q);
        }
      }
    }
    return dist;
  });
}

/** All permutations of 0..n-1, in lexicographic order. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Uint8Array(n);
  const rec = (): void => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = 1;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = 0;
    }
  };
  rec();
  return out;
}

type SearchResult = { pushes: number; moves: string } | null;

/**
 * Push A* over one problem (a room, or a whole level as fallback): states are the
 * sorted boxes plus the player's region, named by its lowest square. Returns the
 * push-optimal moves, or null when the budget runs out or no solution exists.
 */
function pushSearch(prob: Level, budget: number): SearchResult {
  const { w, wall, goals, boxes: startBoxes, player: startPlayer } = prob;
  const size = wall.length;
  const n = startBoxes.length;
  if (n === 0) return { pushes: 0, moves: '' };
  if (n !== goals.length) return null;
  if (startPlayer < 0) return null;

  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(wall, goals, w);
  for (const b of startBoxes) if (!live[b]) return null;

  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  if (solved(startBoxes)) return { pushes: 0, moves: '' };

  // Heuristic: cheapest assignment of boxes to goals by walking distance.
  // Exact min-cost matching for small problems (n <= 5), else the sum of each
  // box's nearest goal — both admissible: one push moves one box one square,
  // so the sum can fall by at most one per push, and it is 0 exactly when solved.
  const dists = goalDistances(wall, goals, w);
  const perms = n <= 5 ? permutations(n) : null;
  const heuristic = (bs: number[]): number => {
    if (perms !== null) {
      let best = Infinity;
      for (const perm of perms) {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const d = dists[perm[i]!]![bs[i]!]!;
          if (d < 0) {
            s = Infinity;
            break;
          }
          s += d;
        }
        if (s < best) best = s;
      }
      return best;
    }
    let s = 0;
    for (const b of bs) {
      let m = Infinity;
      for (let g = 0; g < n; g++) {
        const d = dists[g]![b]!;
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  };

  // The heap, ordered by f, then deeper g first, then insertion order — all deterministic.
  type Entry = { f: number; g: number; seq: number; idx: number };
  const heap: Entry[] = [];
  const less = (a: Entry, b: Entry): boolean =>
    a.f < b.f || (a.f === b.f && (a.g > b.g || (a.g === b.g && a.seq < b.seq)));
  const heapPush = (e: Entry): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): Entry => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  // State storage: boxes, the player's square after the push that made the state,
  // the region's lowest square (the state's name), and the push itself
  // (from -> to, its letter) for rebuilding the moves.
  const sBoxes: number[][] = [startBoxes.slice()];
  const sPlayer: number[] = [startPlayer];
  const sLow: number[] = [0];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sDir: string[] = [''];

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  let mstamp = 0;

  const keyOf = (bs: number[], low: number): string => String.fromCharCode(low, ...bs);
  // States are closed when expanded, never when generated: with a consistent
  // heuristic the first expansion of a state carries its optimal push count,
  // but the first generation may not — closing on generation can keep a
  // longer path and answer a push over the optimum.
  const closed = new Set<string>();

  for (const b of startBoxes) occupied[b] = 1;
  if (startBoxes.some((b) => !goal[b] && frozenBlockAt(wall, occupied, goal, w, b))) return null;
  const startLow = regionLow(wall, occupied, w, startPlayer, seen, ++stamp, stack);
  for (const b of startBoxes) occupied[b] = 0;
  const h0 = heuristic(startBoxes);
  if (h0 === Infinity) return null;
  sLow[0] = startLow;
  heapPush({ f: h0, g: 0, seq: 0, idx: 0 });

  let seq = 0;
  let expanded = 0;
  let found = -1;
  while (heap.length > 0) {
    const { g, idx } = heapPop();
    const boxes = sBoxes[idx]!;
    const key = keyOf(boxes, sLow[idx]!);
    if (closed.has(key)) continue;
    closed.add(key);
    if (solved(boxes)) {
      found = idx;
      break;
    }
    if (expanded >= budget) return null;
    expanded++;
    for (const b of boxes) occupied[b] = 1;
    regionLow(wall, occupied, w, sPlayer[idx]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy, letter] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        let child: number[] | null = null;
        let childLow = -1;
        if (!frozenBlockAt(wall, occupied, goal, w, t)) {
          child = boxes.slice();
          child[bi] = t;
          child.sort((x, y) => x - y);
          // The child's region is flooded on its own marks: flooding it on
          // `seen` would erase the parent region this expansion still reads.
          childLow = regionLow(wall, occupied, w, b, mark, ++mstamp, stack);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (child === null) continue;
        const key = keyOf(child, childLow);
        if (closed.has(key)) continue;
        const h = heuristic(child);
        if (h === Infinity) continue;
        if (sBoxes.length >= budget) return null;
        const ni = sBoxes.length;
        sBoxes.push(child);
        sPlayer.push(b);
        sLow.push(childLow);
        sParent.push(idx);
        sFrom.push(b);
        sTo.push(t);
        sDir.push(letter);
        heapPush({ f: g + 1 + h, g: g + 1, seq: ++seq, idx: ni });
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // Rebuild the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = startBoxes.slice();
  for (const s of path) {
    const from = sFrom[s]!;
    const to = sTo[s]!;
    const d = to - from;
    for (const b of boxes) occupied[b] = 1;
    const walk = walkMoves(wall, occupied, w, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    if (walk === null) throw new Error('push square out of reach while rebuilding');
    moves += walk + sDir[s]!;
    player = from;
    boxes = boxes.map((b) => (b === from ? to : b));
  }
  return { pushes: path.length, moves };
}

/** The square the player ends on after `moves` (LURD, case aside) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

/** The hallway row: the row the player stands on — the generator starts the player on a hallway square. */
function hallwayRow(level: Level): number {
  return Math.floor(level.player / level.w);
}

type Room = { min: number; boxes: number[]; goals: number[] };

/**
 * The level's rooms: floor components once the hallway row is cut out. Null when
 * the level is no set of rooms — a box or goal in the hallway, or a component
 * whose boxes and goals do not match.
 */
function roomsOf(level: Level, hallY: number): Room[] | null {
  const { w, h, wall, goals, boxes } = level;
  if (boxes.some((b) => Math.floor(b / w) === hallY)) return null;
  if (goals.some((g) => Math.floor(g / w) === hallY)) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || Math.floor(s / w) === hallY || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && Math.floor(q / w) !== hallY && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ min: s, boxes: [], goals: [] });
  }
  for (const b of boxes) {
    const r = part[b]!;
    if (r < 0) return null;
    rooms[r]!.boxes.push(b);
  }
  for (const g of goals) {
    const r = part[g]!;
    if (r < 0) return null;
    rooms[r]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  const withBoxes = rooms.filter((r) => r.boxes.length > 0);
  if (withBoxes.length === 0) return null;
  withBoxes.sort((a, b) => a.min - b.min);
  return withBoxes;
}

/** Solve the level room by room; null when the level is no set of rooms or a room gives up. */
function solveByRooms(level: Level): string | null {
  const hallY = hallwayRow(level);
  if (hallY < 0) return null;
  const rooms = roomsOf(level, hallY);
  if (rooms === null) return null;
  const roomBoxes = rooms.map((r) => r.boxes.slice().sort((a, b) => a - b));
  let player = level.player;
  let moves = '';
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri]!;
    // The other rooms' boxes stand as walls; this room's own boxes are the problem's.
    const wall = level.wall.slice();
    for (let rj = 0; rj < rooms.length; rj++) {
      if (rj === ri) continue;
      for (const b of roomBoxes[rj]!) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: roomBoxes[ri]!.slice(),
      player,
    };
    const solved = pushSearch(sub, ROOM_BUDGET);
    if (solved === null) return null;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    roomBoxes[ri] = room.goals.slice().sort((a, b) => a - b);
  }
  return moves;
}

/** One level's moves: room by room, else the whole level, else no moves (still valid). */
function solveLevel(text: string): string {
  try {
    const level = parseLevel(text);
    if (level.player < 0 || level.boxes.length === 0) return '';
    return solveByRooms(level) ?? pushSearch(level, LEVEL_BUDGET)?.moves ?? '';
  } catch {
    return '';
  }
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
