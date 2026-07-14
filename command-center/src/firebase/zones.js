import { collection, doc, setDoc, updateDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from './config';

const zonesCol = (searchId, dayId) =>
  collection(db, 'searches', searchId, 'days', dayId, 'zones');

export async function createZone(searchId, dayId, { number, polygon }) {
  const ref = doc(zonesCol(searchId, dayId));
  await setDoc(ref, {
    number,
    polygon: JSON.stringify(polygon),
    status: 'unassigned', assignedTo: null, createdAt: serverTimestamp(),
  });
  return ref.id;
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
