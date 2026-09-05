// The fleet room is the one workspace whose loss takes the agents with it, so
// its delete asks twice. Keyed on the prod slug: it cannot exist on dev.
export const FLEET_SLUG = 'acme-team-1a2b';
export const isFleetRoom = (slug) => slug === FLEET_SLUG;
