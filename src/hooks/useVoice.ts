import { useCallback, useRef, useState } from 'react';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';

/** Micro (reconnaissance vocale en français) + synthèse vocale. */
export function useVoice(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<string | null>(null);
  const muted = useRef(false);
  const [isMuted, setMuted] = useState(false);

  useSpeechRecognitionEvent('start', () => setListening(true));
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('result', (e) => {
    const text = e.results[0]?.transcript ?? '';
    setPartial(text);
    if (e.isFinal && text) onFinal(text);
  });
  useSpeechRecognitionEvent('error', (e) => {
    setListening(false);
    if (e.error !== 'no-speech' && e.error !== 'aborted') setError('Micro : ' + e.message);
  });

  const listen = useCallback(async () => {
    if (listening) return ExpoSpeechRecognitionModule.stop();
    setError(null);
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) return setError("Autorisez le micro dans les réglages du téléphone pour parler à l'assistant.");
    Speech.stop();
    setPartial('');
    ExpoSpeechRecognitionModule.start({ lang: 'fr-FR', interimResults: true, continuous: false });
  }, [listening]);

  const say = useCallback((text: string) => {
    if (muted.current) return;
    Speech.stop();
    Speech.speak(text, { language: 'fr-FR', rate: 1.0 });
  }, []);

  const toggleMute = useCallback(() => {
    muted.current = !muted.current;
    setMuted(muted.current);
    if (muted.current) Speech.stop();
  }, []);

  return { listening, partial, error, listen, say, isMuted, toggleMute };
}
