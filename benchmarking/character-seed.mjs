export const CHARACTER_SEED_MAX_LENGTH = 64;

export function normalizeCharacterSeed(value) {
  if (value == null) return null;
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) throw new Error('Enter a character seed as text or a whole number.');
  const seed = String(value).trim();
  if (seed.length > CHARACTER_SEED_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(seed)) {
    throw new Error(`Character seed must be at most ${CHARACTER_SEED_MAX_LENGTH} printable characters.`);
  }
  return seed || null;
}

