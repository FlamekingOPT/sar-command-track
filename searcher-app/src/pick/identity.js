export function getIdentity() {
  let id = localStorage.getItem('webVolunteerId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('webVolunteerId', id);
  }
  return {
    id,
    name: localStorage.getItem('webVolunteerName'),
    phone: localStorage.getItem('webVolunteerPhone'),
  };
}

export function saveName(name) {
  localStorage.setItem('webVolunteerName', name);
}

export function savePhone(phone) {
  localStorage.setItem('webVolunteerPhone', phone);
}

// Lets the picker resume an in-flight or already-resolved request after a
// reload or browser-back navigation instead of submitting a duplicate (spec §6).
export function getSavedRequest(searchId) {
  return localStorage.getItem(`zoneRequest:${searchId}`);
}

export function saveRequest(searchId, requestId) {
  localStorage.setItem(`zoneRequest:${searchId}`, requestId);
}
