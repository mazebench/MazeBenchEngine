// Cached movies are disposable derived data. Changes to any compiler module,
// engine build, world metadata, input, or starting room produce a different key.
const DATABASE = "mazebench-replay-cache-v1";
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 3;
const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, "0")).join("");

export async function compilerFingerprint(fetchSource = url => fetch(url, { cache: "no-store" }).then(response => {
  if (!response.ok) throw new Error("Replay compiler fingerprint unavailable");
  return response.text();
})) {
  const modules = new Map();
  const visit = async url => {
    if (modules.has(url)) return;
    modules.set(url, "");
    const source = await fetchSource(url);
    modules.set(url, source);
    const dependencies = [...source.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)];
    await Promise.all(dependencies.map(match => visit(new URL(match[1], url).href)));
  };
  await Promise.all(["./movie.mjs", "./import.mjs", "./worker.mjs"].map(path => visit(new URL(path, import.meta.url).href)));
  return hash(JSON.stringify([...modules].sort(([a], [b]) => a.localeCompare(b))));
}

export async function replayCacheKey({ world, text, start, name, compiler }) {
  // Full definitions include collision heights and mechanism variants, not
  // just role names; a visual definition can change the compiled physics too.
  const fingerprint = await hash(JSON.stringify({ blocks: world.blocks, rooms: world.rooms,
    columns: world.columns, rows: world.rows, roomWidth: world.roomWidth, roomHeight: world.roomHeight }));
  return hash(JSON.stringify([compiler, fingerprint, text, start, name]));
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("movies");
      request.result.createObjectStore("entries", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Replay cache unavailable"));
  });
}
const requestValue = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const complete = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error("Replay cache transaction failed"));
});

export async function readCachedReplay(key) {
  let database;
  try {
    database = await openDatabase();
    const transaction = database.transaction(["movies", "entries"], "readwrite"), done = complete(transaction);
    done.catch(() => {});
    const movie = await requestValue(transaction.objectStore("movies").get(key));
    const metadata = await requestValue(transaction.objectStore("entries").get(key));
    if (movie && metadata) transaction.objectStore("entries").put({ ...metadata, used: Date.now() });
    await done;
    return metadata ? movie : null;
  } catch { return null; }
  finally { database?.close(); }
}

export async function writeCachedReplay(key, movie) {
  let database;
  try {
    // A conservative UTF-16 estimate also accounts for plain-object overhead.
    const bytes = JSON.stringify(movie).length * 2;
    if (bytes > MAX_BYTES) return false;
    database = await openDatabase();
    const transaction = database.transaction(["movies", "entries"], "readwrite"), done = complete(transaction);
    done.catch(() => {});
    const entries = transaction.objectStore("entries"), movies = transaction.objectStore("movies");
    const previous = (await requestValue(entries.getAll())).filter(entry => entry.key !== key).sort((a,b) => b.used - a.used);
    let total = bytes, count = 1;
    for (const entry of previous) {
      if (++count > MAX_ENTRIES || total + entry.bytes > MAX_BYTES) { entries.delete(entry.key); movies.delete(entry.key); }
      else total += entry.bytes;
    }
    movies.put(movie, key); entries.put({ key, bytes, used: Date.now() });
    await done;
    return true;
  } catch { return false; } // Storage denial/quota never prevents an import.
  finally { database?.close(); }
}
