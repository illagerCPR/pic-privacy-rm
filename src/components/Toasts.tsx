export interface ToastItem {
  id: number;
  text: string;
  tone: 'info' | 'ok' | 'bad';
}

interface Props {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}

export function Toasts({ toasts, onDismiss }: Props) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={`toast toast--${toast.tone}`}
          onClick={() => onDismiss(toast.id)}
        >
          {toast.text}
        </button>
      ))}
    </div>
  );
}
