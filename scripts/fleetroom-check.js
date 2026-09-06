// Unit test for the protected-workspace predicate behind the second delete
// confirm (task 14): only the configured slug qualifies, and an unset
// VITE_FLEET_SLUG protects nothing. Run: node scripts/fleetroom-check.js
const path = require('path');
const { pathToFileURL } = require('url');
(async () => {
  const { isFleetRoom, makeIsFleetRoom, FLEET_SLUG } = await import(pathToFileURL(path.join(__dirname, '..', 'web', 'src', 'fleet.js')).href);
  const guarded = makeIsFleetRoom('acme-team-1a2b');
  const cases = [['acme-team-1a2b', true], ['acme-team-1a2b2', false], ['keep-me-1a2b', false], ['', false], [undefined, false]];
  for (const [slug, want] of cases) {
    if (guarded(slug) !== want) throw new Error('guarded(' + JSON.stringify(slug) + ') != ' + want);
  }
  // no slug configured: nothing is protected, not even the empty slug
  if (FLEET_SLUG !== '' || makeIsFleetRoom('')('') !== false) throw new Error('an unset slug must protect nothing');
  if (typeof isFleetRoom !== 'function') throw new Error('isFleetRoom is not exported');
  console.log('FLEETROOM_CHECK_OK');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
