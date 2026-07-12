import { DAY_ID } from '../constants.js';

// The single assignment authority for web-originated requests. Deliberately
// calls the exact same helpers available.js calls, so a letter can't be
// double-assigned by the two channels running different logic (spec §5).
export function watchZoneRequests() {
  let unsubscribe = () => {};
  (async () => {
    const { db } = await import('../firebase/config.js');
    const { saveVolunteer } = await import('../firebase/volunteers.js');
    const { fetchZones, assignZone } = await import('../firebase/zones.js');
    const { createSearcherLink } = await import('../firebase/links.js');
    const { pickZone } = await import('../assignment/assign.js');
    const { resolveRequest } = await import('../firebase/zoneRequests.js');

    unsubscribe = db.collection('zoneRequests')
      .where('status', '==', 'pending')
      .onSnapshot(async snap => {
        for (const change of snap.docChanges()) {
          if (change.type !== 'added') continue;
          const req = { id: change.doc.id, ...change.doc.data() };

          await saveVolunteer({ id: req.webVolunteerId, name: req.name });
          const zones = await fetchZones(req.searchId, DAY_ID);
          const zone = pickZone(zones, [req.letter]);
          if (!zone) {
            await resolveRequest(req.id, { status: 'no_availability' });
            continue;
          }
          const token = await createSearcherLink({
            searchId: req.searchId, dayId: DAY_ID, zoneId: zone.id, volunteerId: req.webVolunteerId,
          });
          await assignZone(req.searchId, DAY_ID, zone.id, { status: 'assigned', assignedTo: req.webVolunteerId });
          await resolveRequest(req.id, { status: 'assigned', zoneId: zone.id, token });
        }
      }, err => console.error('zoneRequestWatcher error:', err));
  })();
  return () => unsubscribe();
}
