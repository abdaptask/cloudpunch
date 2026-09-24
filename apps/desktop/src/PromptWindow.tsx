import { api } from './api.js';
import { IdlePrompt } from './IdlePrompt.js';
import { useAgentState } from './useAgentState.js';

/**
 * Contents of the `idle-prompt` window. The Rust agent opens this
 * window when the idle threshold passes and destroys it when the
 * prompt is answered, a call starts, or the grace timer expires; the
 * deadline shown here is whatever the core last reported.
 */

const ERROR_TEXT: Record<string, string> = {
  note_required: 'Please add a short note.',
  note_too_long: 'That note is too long.',
  option_not_offered: "That option isn't available.",
  invalid_transition: 'The prompt has already closed.',
};

export function PromptWindow(): JSX.Element | null {
  const { view, error, run } = useAgentState();

  if (view?.status !== 'idle_pending' || view.promptDeadline === null) return null;

  return (
    <>
      <IdlePrompt
        deadline={view.promptDeadline}
        options={view.promptOptions}
        noteRequiredFor={view.noteRequiredFor}
        onRespond={(response, note) => run(() => api.respondToPrompt(response, note))}
      />
      {error && (
        <p role="alert" style={{ margin: '0 20px', fontSize: 13, color: '#a00' }}>
          {ERROR_TEXT[error] ?? `Something went wrong (${error}).`}
        </p>
      )}
    </>
  );
}
