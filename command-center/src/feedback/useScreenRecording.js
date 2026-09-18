import { useCallback, useEffect, useRef, useState } from 'react';

// Hard ceiling so a tester who forgets to stop doesn't fill the Storage
// bucket (storage.rules also caps upload SIZE server-side, independently).
export const MAX_RECORDING_MS = 3 * 60 * 1000;

export function useScreenRecording() {
  const [recording, setRecording] = useState(false);
  const [videoBlob, setVideoBlob] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [error, setError] = useState('');
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timeoutRef = useRef(null);

  const stop = useCallback(() => {
    clearTimeout(timeoutRef.current);
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
  }, []);

  const start = useCallback(async () => {
    setError('');
    setVideoBlob(null);
    setPreviewUrl(null);
    try {
      // audio:true asks for the shared tab/window's own audio, not the mic —
      // browsers vary in support (falls back silently to video-only if denied).
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        setVideoBlob(blob);
        setPreviewUrl(URL.createObjectURL(blob));
        setRecording(false);
      };
      // The browser's own "Stop sharing" control ends the track without going
      // through our stop button — catch that too so state doesn't get stuck.
      stream.getVideoTracks()[0].addEventListener('ended', stop);
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      timeoutRef.current = setTimeout(stop, MAX_RECORDING_MS);
    } catch (err) {
      if (err.name !== 'NotAllowedError') console.error('getDisplayMedia failed:', err);
      setError(err.name === 'NotAllowedError' ? '' : 'Could not start screen recording.');
    }
  }, [stop]);

  const reset = useCallback(() => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setVideoBlob(null);
    setPreviewUrl(null);
  }, [previewUrl]);

  // Closing the report overlay mid-recording (or any other unmount) must not
  // leave the OS-level "sharing your screen" capture running with no way to
  // stop it short of reloading the page.
  useEffect(() => () => {
    clearTimeout(timeoutRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
  }, []);

  return { recording, videoBlob, previewUrl, error, start, stop, reset };
}
