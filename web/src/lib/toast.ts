// Module-level pub/sub instead of a React Context -- this app has zero
// context providers today (see layout.tsx), and a toast's content doesn't
// need to flow through the component tree, just reach one listener
// (ToastHost). Call notify() from anywhere (client components, event
// handlers) without wrapping the app in a provider.
export type ToastTone = "success" | "error";

export type ToastMessage = {
  id: number;
  text: string;
  tone: ToastTone;
};

type Listener = (toast: ToastMessage) => void;

let nextId = 1;
const listeners = new Set<Listener>();

export function notify(text: string, tone: ToastTone = "success") {
  const toast: ToastMessage = { id: nextId++, text, tone };
  listeners.forEach((listener) => listener(toast));
}

export function subscribeToToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
