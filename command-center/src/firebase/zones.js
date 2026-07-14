import { collection, doc, updateDoc, onSnapshot, serverTimestamp, writeBatch } from 'firebase/firestore';
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
    for (const { number, polygon } of zones.slice(i, i + 500)) {
      batch.set(doc(col), {
        number,
        polygon: JSON.stringify(polygon),
        status: 'unassigned', assignedTo: null, createdAt: serverTimestamp(),
      });
    }
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
