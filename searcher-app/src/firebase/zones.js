import { doc, collection, getDoc, updateDoc, onSnapshot } from 'firebase/firestore';
import { db } from './config';

const zoneDoc = ({ searchId, dayId, zoneId }) =>
  doc(db, 'searches', searchId, 'days', dayId, 'zones', zoneId);

function parseZone(snap) {
  const data = snap.data();
  return {
    id: snap.id,
    ...data,
    polygon: data.polygon ? JSON.parse(data.polygon) : null, // stored as JSON string
  };
}

export async function getZone(ref) {
  const snap = await getDoc(zoneDoc(ref));
  return snap.exists() ? parseZone(snap) : null;
}

export function watchZone(ref, cb) {
  return onSnapshot(zoneDoc(ref), snap => {
    if (snap.exists()) cb(parseZone(snap));
  });
}

export async function updateZoneStatus({ searchId, dayId, zoneId, status }) {
  await updateDoc(zoneDoc({ searchId, dayId, zoneId }), { status });
}

export function watchZones(searchId, dayId, cb) {
  const zonesCol = collection(db, 'searches', searchId, 'days', dayId, 'zones');
  return onSnapshot(zonesCol, snap => cb(snap.docs.map(parseZone)));
}
