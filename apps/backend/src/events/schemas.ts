import { z } from 'zod';

const ULID = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'must be a Crockford ULID');
const IANA_TZ = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9+\-/_]{1,63}$/, 'must be an IANA time zone name');
const SEMVER = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'must be semver');
const BASE64_SIG = z
  .string()
  .min(86) // 64 bytes base64 (unpadded) = 88 chars; padded = 88; url-safe unpadded = 86
  .max(88)
  .regex(/^[A-Za-z0-9+/_=-]+$/, 'must be base64 (standard or url-safe)');

export const EVENT_TYPES = [
  'USER_CLOCK_IN',
  'USER_CLOCK_OUT',
  'USER_PROMPT_RESPONSE',
  'USER_START_BREAK',
  'USER_END_BREAK',
  'USER_MARK_AWAY',
  'USER_MARK_BACK',
  'INPUT_ACTIVITY',
  'INPUT_IDLE_5M',
  'PROMPT_TIMEOUT_30S',
  'MEDIA_DEVICE_STATE',
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
] as const;

export const eventItemSchema = z
  .object({
    event_ulid: ULID,
    event_type: z.enum(EVENT_TYPES),
    sequence_number: z.number().int().min(1),
    client_ts: z.string().datetime({ offset: true }),
    monotonic_ns: z.number().int().min(0),
    tz_iana: IANA_TZ,
    utc_offset_minutes: z.number().int().min(-720).max(840),
    app_version: SEMVER,
    origin: z.enum(['user', 'system_watcher', 'server', 'reconstructed']),
    offline_captured: z.boolean(),
    payload: z.record(z.string(), z.unknown()).default({}),
    integrity_signature: BASE64_SIG,
    parent_event_ulid: ULID.nullable(),
  })
  .strict();

export type EventItem = z.infer<typeof eventItemSchema>;

export const ingestBatchBodySchema = z
  .object({
    device_id: z.string().uuid(),
    session_id: z.string().uuid(),
    employee_id: z.string().uuid(),
    correlation_id: z.string().uuid(),
    /**
     * Optional take-over hint. When true, and the batch opens a new
     * session while the employee already has an open session on a
     * different session_id, the existing session is closed with
     * closed_reason='remote_takeover' before the new one is opened.
     * See ADR-0003 §8.
     */
    take_over: z.boolean().optional().default(false),
    events: z.array(eventItemSchema).min(1).max(100),
  })
  .strict();

export type IngestBatchBody = z.infer<typeof ingestBatchBodySchema>;
