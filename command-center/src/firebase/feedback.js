import { collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, orderBy, query } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage } from './config';

const feedbackCol = collection(db, 'feedback');

export async function uploadFeedbackVideo(blob) {
  const path = `feedback/${crypto.randomUUID()}.webm`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, blob, { contentType: 'video/webm' });
  return getDownloadURL(storageRef);
}

export async function createFeedback({ type, title, description, severity, reporter, videoURL }) {
  await addDoc(feedbackCol, {
    type, title, description,
    severity: type === 'bug' ? severity : null,
    reporter: reporter || null,
    videoURL: videoURL || null,
    status: 'new',
    createdAt: serverTimestamp(),
  });
}

export async function updateFeedbackStatus(reportId, status) {
  await updateDoc(doc(db, 'feedback', reportId), { status });
}

export async function deleteFeedback(reportId) {
  await deleteDoc(doc(db, 'feedback', reportId));
}

export function watchFeedback(cb) {
  return onSnapshot(query(feedbackCol, orderBy('createdAt', 'desc')), snap =>
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}
