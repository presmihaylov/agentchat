// One workspace can be marked protected: deleting it takes every agent token
// with it, so its delete asks twice. Set VITE_FLEET_SLUG at build time to name
// it; unset (the default, and every dev build) means no workspace is protected.
export const FLEET_SLUG = (typeof import.meta.env === 'object' && import.meta.env.VITE_FLEET_SLUG) || '';
export const makeIsFleetRoom = (protectedSlug) => (slug) => !!protectedSlug && slug === protectedSlug;
export const isFleetRoom = makeIsFleetRoom(FLEET_SLUG);
