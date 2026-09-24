import { describe, expect, it } from 'vitest';
import { INITIAL_STATE, deriveState, nextState, type PayrollState } from './state-machine.js';

describe('nextState — ambient events (never change state)', () => {
  const ambient = [
    'SYSTEM_LOCK',
    'SYSTEM_UNLOCK',
    'SYSTEM_SLEEP',
    'SYSTEM_WAKE',
    'NETWORK_OFFLINE',
    'NETWORK_ONLINE',
    'SERVER_ACK',
    'SERVER_REJECT',
    'CLOCK_DRIFT_DETECTED',
    'SESSION_RECOVERED',
    'INTEGRITY_VIOLATION',
  ];
  const states: PayrollState[] = ['ACTIVE', 'ON_CALL', 'ON_BREAK', 'AWAY', 'IDLE_PENDING'];

  for (const evt of ambient) {
    for (const s of states) {
      it(`${evt} from ${s} stays ${s}`, () => {
        expect(nextState(s, evt)).toBe(s);
      });
    }
  }
});

describe('nextState — USER_CLOCK_IN is invalid whenever the session exists', () => {
  const states: PayrollState[] = [
    'ACTIVE',
    'ON_CALL',
    'ON_BREAK',
    'AWAY',
    'IDLE_PENDING',
    'CLOSED',
  ];
  for (const s of states) {
    it(`USER_CLOCK_IN from ${s} is null (invalid)`, () => {
      expect(nextState(s, 'USER_CLOCK_IN')).toBeNull();
    });
  }
});

describe('nextState — USER_CLOCK_OUT closes the session from any open state', () => {
  const open: PayrollState[] = ['ACTIVE', 'ON_CALL', 'ON_BREAK', 'AWAY', 'IDLE_PENDING'];
  for (const s of open) {
    it(`USER_CLOCK_OUT from ${s} → CLOSED`, () => {
      expect(nextState(s, 'USER_CLOCK_OUT')).toBe('CLOSED');
    });
  }
  it('USER_CLOCK_OUT from CLOSED is invalid', () => {
    expect(nextState('CLOSED', 'USER_CLOCK_OUT')).toBeNull();
  });
});

describe('nextState — breaks', () => {
  it('USER_START_BREAK from ACTIVE → ON_BREAK', () => {
    expect(nextState('ACTIVE', 'USER_START_BREAK')).toBe('ON_BREAK');
  });
  it('USER_START_BREAK from ON_BREAK is invalid', () => {
    expect(nextState('ON_BREAK', 'USER_START_BREAK')).toBeNull();
  });
  it('USER_START_BREAK from AWAY is invalid', () => {
    expect(nextState('AWAY', 'USER_START_BREAK')).toBeNull();
  });
  it('USER_END_BREAK from ON_BREAK → ACTIVE', () => {
    expect(nextState('ON_BREAK', 'USER_END_BREAK')).toBe('ACTIVE');
  });
  it('USER_END_BREAK from ACTIVE is invalid', () => {
    expect(nextState('ACTIVE', 'USER_END_BREAK')).toBeNull();
  });
});

describe('nextState — away', () => {
  it('USER_MARK_AWAY from ACTIVE → AWAY', () => {
    expect(nextState('ACTIVE', 'USER_MARK_AWAY')).toBe('AWAY');
  });
  it('USER_MARK_AWAY from ON_BREAK is invalid', () => {
    expect(nextState('ON_BREAK', 'USER_MARK_AWAY')).toBeNull();
  });
  it('USER_MARK_BACK from AWAY → ACTIVE', () => {
    expect(nextState('AWAY', 'USER_MARK_BACK')).toBe('ACTIVE');
  });
  it('USER_MARK_BACK from ACTIVE is invalid', () => {
    expect(nextState('ACTIVE', 'USER_MARK_BACK')).toBeNull();
  });
});

describe('nextState — idle and prompt', () => {
  it('INPUT_IDLE_5M from ACTIVE → IDLE_PENDING', () => {
    expect(nextState('ACTIVE', 'INPUT_IDLE_5M')).toBe('IDLE_PENDING');
  });
  it('INPUT_IDLE_5M from ON_BREAK is invalid', () => {
    expect(nextState('ON_BREAK', 'INPUT_IDLE_5M')).toBeNull();
  });
  it('PROMPT_TIMEOUT_30S from IDLE_PENDING → CLOSED', () => {
    expect(nextState('IDLE_PENDING', 'PROMPT_TIMEOUT_30S')).toBe('CLOSED');
  });
  it('PROMPT_TIMEOUT_30S from ACTIVE is invalid', () => {
    expect(nextState('ACTIVE', 'PROMPT_TIMEOUT_30S')).toBeNull();
  });
  it('INPUT_ACTIVITY from IDLE_PENDING stays IDLE_PENDING (ADR-0008)', () => {
    expect(nextState('IDLE_PENDING', 'INPUT_ACTIVITY')).toBe('IDLE_PENDING');
  });
  it('prompt is still answerable after input (ADR-0008)', () => {
    const afterInput = nextState('IDLE_PENDING', 'INPUT_ACTIVITY');
    expect(afterInput).toBe('IDLE_PENDING');
    expect(nextState(afterInput!, 'USER_PROMPT_RESPONSE', { response: 'bio_break' })).toBe(
      'ON_BREAK',
    );
  });
  it('INPUT_ACTIVITY from ACTIVE stays ACTIVE', () => {
    expect(nextState('ACTIVE', 'INPUT_ACTIVITY')).toBe('ACTIVE');
  });
});

describe('nextState — MEDIA_DEVICE_STATE and ON_CALL (ADR-0009)', () => {
  const media = (inUse: unknown): Record<string, unknown> => ({ in_use: inUse });

  it('in_use=true from ACTIVE → ON_CALL', () => {
    expect(nextState('ACTIVE', 'MEDIA_DEVICE_STATE', media(true))).toBe('ON_CALL');
  });
  it('in_use=true from IDLE_PENDING → ON_CALL (call dismisses the prompt)', () => {
    expect(nextState('IDLE_PENDING', 'MEDIA_DEVICE_STATE', media(true))).toBe('ON_CALL');
  });
  it('in_use=false from ON_CALL → ACTIVE', () => {
    expect(nextState('ON_CALL', 'MEDIA_DEVICE_STATE', media(false))).toBe('ACTIVE');
  });

  const unchanged: [PayrollState, boolean][] = [
    ['ACTIVE', false],
    ['IDLE_PENDING', false],
    ['ON_CALL', true],
    ['ON_BREAK', true],
    ['ON_BREAK', false],
    ['AWAY', true],
    ['AWAY', false],
    ['CLOSED', true],
    ['CLOSED', false],
  ];
  for (const [s, inUse] of unchanged) {
    it(`in_use=${inUse} from ${s} stays ${s}`, () => {
      expect(nextState(s, 'MEDIA_DEVICE_STATE', media(inUse))).toBe(s);
    });
  }

  it('missing payload is invalid', () => {
    expect(nextState('ACTIVE', 'MEDIA_DEVICE_STATE')).toBeNull();
  });
  it('non-boolean in_use is invalid, even where the event would be ambient', () => {
    expect(nextState('ACTIVE', 'MEDIA_DEVICE_STATE', media('true'))).toBeNull();
    expect(nextState('ON_BREAK', 'MEDIA_DEVICE_STATE', media(1))).toBeNull();
  });

  it('USER_START_BREAK from ON_CALL → ON_BREAK', () => {
    expect(nextState('ON_CALL', 'USER_START_BREAK')).toBe('ON_BREAK');
  });
  it('INPUT_ACTIVITY from ON_CALL stays ON_CALL', () => {
    expect(nextState('ON_CALL', 'INPUT_ACTIVITY')).toBe('ON_CALL');
  });
  const rejectedFromOnCall = [
    'USER_MARK_AWAY',
    'USER_MARK_BACK',
    'USER_END_BREAK',
    'INPUT_IDLE_5M',
    'PROMPT_TIMEOUT_30S',
  ];
  for (const evt of rejectedFromOnCall) {
    it(`${evt} from ON_CALL is invalid`, () => {
      expect(nextState('ON_CALL', evt)).toBeNull();
    });
  }
  it('USER_PROMPT_RESPONSE from ON_CALL is invalid', () => {
    expect(nextState('ON_CALL', 'USER_PROMPT_RESPONSE', { response: 'still_working' })).toBeNull();
  });
});

describe('nextState — USER_PROMPT_RESPONSE dispatches on payload.response', () => {
  it('still_working → ACTIVE', () => {
    expect(nextState('IDLE_PENDING', 'USER_PROMPT_RESPONSE', { response: 'still_working' })).toBe(
      'ACTIVE',
    );
  });
  it('bio_break → ON_BREAK', () => {
    expect(nextState('IDLE_PENDING', 'USER_PROMPT_RESPONSE', { response: 'bio_break' })).toBe(
      'ON_BREAK',
    );
  });
  it('meal_break → ON_BREAK', () => {
    expect(nextState('IDLE_PENDING', 'USER_PROMPT_RESPONSE', { response: 'meal_break' })).toBe(
      'ON_BREAK',
    );
  });
  it('on_phone_call → AWAY', () => {
    expect(nextState('IDLE_PENDING', 'USER_PROMPT_RESPONSE', { response: 'on_phone_call' })).toBe(
      'AWAY',
    );
  });
  it('working_away → AWAY', () => {
    expect(nextState('IDLE_PENDING', 'USER_PROMPT_RESPONSE', { response: 'working_away' })).toBe(
      'AWAY',
    );
  });
  it('end_shift → CLOSED', () => {
    expect(nextState('IDLE_PENDING', 'USER_PROMPT_RESPONSE', { response: 'end_shift' })).toBe(
      'CLOSED',
    );
  });
  it('unknown response is invalid', () => {
    expect(nextState('IDLE_PENDING', 'USER_PROMPT_RESPONSE', { response: 'party' })).toBeNull();
  });
  it('response with no payload is invalid', () => {
    expect(nextState('IDLE_PENDING', 'USER_PROMPT_RESPONSE')).toBeNull();
  });
  it('response from ACTIVE (no prompt to respond to) is invalid', () => {
    expect(nextState('ACTIVE', 'USER_PROMPT_RESPONSE', { response: 'still_working' })).toBeNull();
  });
});

describe('nextState — unknown event type', () => {
  it('returns null for a nonsense event type', () => {
    expect(nextState('ACTIVE', 'BOGUS_EVENT')).toBeNull();
  });
});

describe('deriveState — folding an event stream', () => {
  const mk = (eventType: string, payload: Record<string, unknown> = {}) => ({
    eventType,
    payload,
  });

  it('empty stream → INITIAL_STATE (ACTIVE)', () => {
    expect(deriveState([])).toBe(INITIAL_STATE);
  });

  it('full workday: active → break → active → away → active → clock_out', () => {
    const stream = [
      mk('USER_CLOCK_IN'), // ignored (invalid from ACTIVE), state stays ACTIVE
      mk('INPUT_ACTIVITY'),
      mk('USER_START_BREAK'),
      mk('USER_END_BREAK'),
      mk('USER_MARK_AWAY'),
      mk('USER_MARK_BACK'),
      mk('USER_CLOCK_OUT'),
    ];
    expect(deriveState(stream)).toBe('CLOSED');
  });

  it('idle → prompt response bio_break → end_break → active', () => {
    const stream = [
      mk('INPUT_IDLE_5M'),
      mk('USER_PROMPT_RESPONSE', { response: 'bio_break' }),
      mk('USER_END_BREAK'),
    ];
    expect(deriveState(stream)).toBe('ACTIVE');
  });

  it('ambient events do not change state', () => {
    const stream = [
      mk('INPUT_ACTIVITY'),
      mk('SYSTEM_LOCK'),
      mk('SYSTEM_UNLOCK'),
      mk('NETWORK_OFFLINE'),
      mk('NETWORK_ONLINE'),
    ];
    expect(deriveState(stream)).toBe('ACTIVE');
  });

  it('call during the idle prompt: IDLE_PENDING → ON_CALL → ACTIVE', () => {
    const stream = [
      mk('INPUT_IDLE_5M'),
      mk('MEDIA_DEVICE_STATE', { in_use: true }),
      mk('MEDIA_DEVICE_STATE', { in_use: false }),
    ];
    expect(deriveState(stream)).toBe('ACTIVE');
  });

  it('invalid transitions in the stream are skipped (defensive)', () => {
    // USER_END_BREAK from ACTIVE is invalid; state stays ACTIVE.
    // Then USER_MARK_AWAY (valid from ACTIVE) → AWAY.
    const stream = [mk('USER_END_BREAK'), mk('USER_MARK_AWAY')];
    expect(deriveState(stream)).toBe('AWAY');
  });
});
