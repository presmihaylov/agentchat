// Unit test for the fleet-room predicate behind the second delete confirm
// (task 14): only the prod slug qualifies, so the browser check on dev can
// never reach that branch. Run: node scripts/fleetroom-check.js
const path = require('path');
const { pathToFileURL } = require('url');
(async () => {
  const { isFleetRoom, FLEET_SLUG } = await import(pathToFileURL(path.join(__dirname, '..', 'web', 'src', 'fleet.js')).href);
  const cases = [[FLEET_SLUG, true], ['acme-team-1a2b', true], ['acme-team-1a2b2', false], ['keep-me-1a2b', false], ['', false], [undefined, false]];
  for (const [slug, want] of cases) {
    if (isFleetRoom(slug) !== want) throw new Error('isFleetRoom(' + JSON.stringify(slug) + ') != ' + want);
  }
  console.log('FLEETROOM_CHECK_OK');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
