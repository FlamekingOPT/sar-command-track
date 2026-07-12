import { doc, getDoc } from 'firebase/firestore';
import { db } from './config';

export async function getSearch(searchId) {
  const snap = await getDoc(doc(db, 'searches', searchId));
  if (!snap.exists()) return null;
  const data = snap.data();
  return {
    id: snap.id,
    ...data,
    letterZones: (data.letterZones ?? []).map(z => ({
      ...z,
      geometry: z.geometry ? JSON.parse(z.geometry) : null,
    })),
  };
}
