import { collection, doc, getDocs, updateDoc, onSnapshot, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db } from './config';

const zonesCol = (searchId, dayId) =>
  collection(db, 'searches', searchId, 'days', dayId, 'zones');

// A large boundary can generate hundreds of zones — creating them one
// sequential await at a time made zone generation feel like it had hung.
// Firestore batches cap at 500 writes, so chunk if there are more than that.
export async function createZones(searchId, dayId, zones) {
  const col = zonesCol(searchId, dayId);
  for (let i = 0; i < zones.length; i += 500) {
    const batch = writeBatch(db);
    for (const { number, polygon, boundaryId } of zones.slice(i, i + 500)) {
      batch.set(doc(col), {
        number,
        polygon: JSON.stringify(polygon),
        boundaryId: boundaryId ?? null,
        status: 'unassigned', assignedTo: null, createdAt: serverTimestamp(),
      });
    }
    await batch.commit();
  }
}

// Regenerating or editing one boundary must replace only ITS zones — other
// boundaries' zones (and any searcher assignments on them) stay intact.
// Filtered client-side, not with where('boundaryId','==',…): legacy zones have
// NO boundaryId field at all (Firestore where can't match a missing field), so
// they're attributed to the shim boundary 'legacy-1' here. Zone counts are a
// few hundred at most — one full read is fine.
export async function deleteZonesForBoundary(searchId, dayId, boundaryId) {
  const snap = await getDocs(zonesCol(searchId, dayId));
  const refs = snap.docs
    .filter(d => (d.data().boundaryId ?? 'legacy-1') === boundaryId)
    .map(d => d.ref);
  while (refs.length) {
    const batch = writeBatch(db);
    refs.splice(0, 500).forEach(ref => batch.delete(ref));
    await batch.commit();
  }
}

export async function updateZoneStatus(searchId, dayId, zoneId, status) {
  await updateDoc(doc(db, 'searches', searchId, 'days', dayId, 'zones', zoneId), { status });
}

export function watchZones(searchId, dayId, cb) {
  return onSnapshot(zonesCol(searchId, dayId), snap =>
    cb(snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        polygon: data.polygon ? JSON.parse(data.polygon) : null,
      };
    }))
  );
}
