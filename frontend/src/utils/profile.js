// frontend/src/utils/profile.js

const KEY = "bc_profile_v1";

/**
 * Generate a stable random user id (no external deps)
 */
function generateUserId() {
  return (
    "u_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 10)
  );
}

/**
 * Get profile from localStorage
 * - Ensures user_id always exists
 * - Backfills missing fields safely
 */
export function getProfile() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;

    const profile = JSON.parse(raw);
    if (!profile || typeof profile !== "object") return null;

    // ✅ Ensure stable user_id (critical for email scheduling)
    if (!profile.user_id) {
      profile.user_id = generateUserId();
      localStorage.setItem(KEY, JSON.stringify(profile));
    }

    return profile;
  } catch {
    return null;
  }
}

/**
 * Save profile
 * - Preserves existing user_id
 * - Auto-generates one if missing
 */
export function saveProfile(profile) {
  if (!profile || typeof profile !== "object") return;

  const existing = getProfile() || {};

  const merged = {
    ...existing,
    ...profile,
    user_id: profile.user_id || existing.user_id || generateUserId(),
  };

  localStorage.setItem(KEY, JSON.stringify(merged));
}

/**
 * Clear profile completely
 */
export function clearProfile() {
  localStorage.removeItem(KEY);
}
