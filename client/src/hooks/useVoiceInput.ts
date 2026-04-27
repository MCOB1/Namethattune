import { useState, useRef, useCallback, useEffect } from "react";

interface UseVoiceInputOptions {
  onResult: (transcript: string) => void;
  onError?: (error: string) => void;
  language?: string;
}

export type VoiceState = "idle" | "listening" | "processing" | "unsupported";

export function useVoiceInput({ onResult, onError, language = "en-US" }: UseVoiceInputOptions) {
  const [state, setState] = useState<VoiceState>(() => {
    if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) {
      return "unsupported";
    }
    return "idle";
  });

  const recognitionRef = useRef<SpeechRecognition | null>(null);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
    };
  }, []);

  const startListening = useCallback(() => {
    if (state === "unsupported") return;

    const SpeechRecognitionAPI =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      setState("unsupported");
      return;
    }

    const recognition: SpeechRecognition = new SpeechRecognitionAPI();
    recognition.lang = language;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.onstart = () => setState("listening");

    recognition.onresult = (event) => {
      setState("processing");
      const transcript = event.results[0][0].transcript;
      onResult(transcript);
      setState("idle");
    };

    recognition.onerror = (event) => {
      setState("idle");
      if (event.error !== "aborted" && event.error !== "no-speech") {
        onError?.(event.error);
      }
    };

    recognition.onend = () => {
      if (state === "listening") setState("idle");
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [state, language, onResult, onError]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setState("idle");
  }, []);

  const toggle = useCallback(() => {
    if (state === "listening") {
      stopListening();
    } else {
      startListening();
    }
  }, [state, startListening, stopListening]);

  return { state, toggle, startListening, stopListening };
}
