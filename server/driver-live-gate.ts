/**
 * Mongo-backed live-location check-in + continuous membership gate.
 * Collection: driverLiveGate (one document per Telegram user).
 *
 * Runs only on the desk that receives Telegram updates (TELEGRAM_ACCEPT_POLL
 * or TELEGRAM_WEBHOOK_URL). No-op unless DRIVER_LIVE_GATE=1.
 */
import { getDatabase, isMongoConfigured } from "./mongodb";
import { isDispatchGroupChat, type DriverLocationPoint } from "./driver-location-helpers";
import { recordSeen } from "./driver-checkin";
import {
  exemptionFor,
  kickMember,
  MISSING_RIGHTS_NOTE,
  type TgApi,
} from "./driver-removal-helpers";
import { parseAdminIds } from "./telegram-where-helpers";
import {
  applyJoin,
  checkinReplyText,
  classifyLocationUpdate,
  decideGateAction,
  effectiveLiveGateConfig,
  graceMinutes,
  isAlreadyParticipant,
  joinWelcomeText,
  locationStoppedNotice,
  locationStoppedWarning,
  parseJoinRequest,
  reduceLocation,
  removalNotice,
  type GateAction,
  type LiveGateConfig,
  type LiveGateState,
} from "./driver-live-gate-helpers";

const COLLECTION = "driverLiveGate";
/** How often the poller desk evaluates join deadlines and stale shares. */
export const LIVE_GATE_SWEEP_MS = 20_000;
const RIGHTS_BACKOFF_MS = 6 * 3600_000;

export interface LiveGateCtx {
  api: TgApi;
  dispatchChatId: string | null;
  now?: number;
}

let indexesReady: Promise<void> | undefined;
async function db() {
  const d = await getDatabase();
  if (!indexesReady) {
    indexesReady = d.collection(COLLECTION).createIndex({ telegramUserId: 1 }, { unique: true })
      .then(() => undefined)
      .catch((e) => { indexesReady = undefined; throw e; });
  }
  await indexesReady;
  return d;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fromDoc(doc: any): LiveGateState {
  const id = Number(doc.telegramUserId);
  const name = typeof doc.driverName === "string" && doc.driverName ? doc.driverName : `User ${id}`;
  return {
    telegramUserId: id,
    driverName: name,
    joinedAt: numOrNull(doc.joinedAt),
    checkedIn: Boolean(doc.checkedIn),
    isLive: Boolean(doc.isLive),
    liveStartedAt: numOrNull(doc.liveStartedAt),
    livePeriod: numOrNull(doc.livePeriod),
    lastFixAt: numOrNull(doc.lastFixAt),
    stoppedAt: numOrNull(doc.stoppedAt),
    warnedAt: numOrNull(doc.warnedAt),
    removedAt: numOrNull(doc.removedAt),
    hold: doc.hold === "exempt" ? "exempt" : null,
    shareGen: typeof doc.shareGen === "number" && Number.isFinite(doc.shareGen) ? doc.shareGen : 0,
    lat: numOrNull(doc.lat),
    lon: numOrNull(doc.lon),
    liveChatId: doc.liveChatId != null ? String(doc.liveChatId) : null,
    liveMessageId: numOrNull(doc.liveMessageId),
  };
}

async function loadState(telegramUserId: number): Promise<LiveGateState | null> {
  if (!isMongoConfigured) return null;
  const d = await db();
  const doc = await d.collection(COLLECTION).findOne({ telegramUserId });
  return doc ? fromDoc(doc) : null;
}

async function listStates(): Promise<LiveGateState[]> {
  if (!isMongoConfigured) return [];
  const d = await db();
  const docs = await d.collection(COLLECTION).find({}).toArray();
  return docs.map(fromDoc);
}

/**
 * `stop` does not write warnedAt / removedAt / hold / shareGen, so a sweep
 * claim that landed while this update was in flight is not wiped.
 * `checkin` and `join` intentionally clear the warn/remove clock.
 */
async function persist(state: LiveGateState, mode: "checkin" | "stop" | "join"): Promise<void> {
  const d = await db();
  const fields: Record<string, unknown> = { ...state, updatedAt: new Date() };
  if (mode === "stop") {
    delete fields.warnedAt;
    delete fields.removedAt;
    delete fields.hold;
    delete fields.shareGen;
  }
  await d.collection(COLLECTION).updateOne(
    { telegramUserId: state.telegramUserId },
    { $set: fields },
    { upsert: true },
  );
}

async function claimWarn(telegramUserId: number, now: number, shareGen: number): Promise<boolean> {
  const d = await db();
  const r = await d.collection(COLLECTION).updateOne(
    { telegramUserId, warnedAt: null, shareGen, removedAt: null, hold: null },
    { $set: { warnedAt: now, updatedAt: new Date() } },
  );
  return r.matchedCount > 0;
}

async function clearWarn(telegramUserId: number, now: number, shareGen: number): Promise<void> {
  const d = await db();
  await d.collection(COLLECTION).updateOne(
    { telegramUserId, warnedAt: now, shareGen },
    { $set: { warnedAt: null, updatedAt: new Date() } },
  );
}

async function claimRemove(telegramUserId: number, now: number, shareGen: number): Promise<boolean> {
  const d = await db();
  const r = await d.collection(COLLECTION).updateOne(
    { telegramUserId, removedAt: null, shareGen, hold: null },
    { $set: { removedAt: now, checkedIn: false, isLive: false, updatedAt: new Date() } },
  );
  return r.matchedCount > 0;
}

async function releaseRemove(state: LiveGateState, claimedAt: number): Promise<void> {
  const d = await db();
  await d.collection(COLLECTION).updateOne(
    { telegramUserId: state.telegramUserId, removedAt: claimedAt, shareGen: state.shareGen },
    { $set: { removedAt: null, checkedIn: state.checkedIn, isLive: state.isLive, updatedAt: new Date() } },
  );
}

async function setHold(telegramUserId: number): Promise<void> {
  const d = await db();
  await d.collection(COLLECTION).updateOne(
    { telegramUserId },
    { $set: { hold: "exempt", removedAt: null, updatedAt: new Date() } },
  );
}

function messageIdOf(update: any): number | null {
  const id = update?.edited_message?.message_id ?? update?.message?.message_id;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

async function notifyAdmins(api: TgApi, text: string): Promise<void> {
  for (const id of Array.from(parseAdminIds(process.env.TELEGRAM_ADMIN_IDS))) {
    try {
      const r = await api("sendMessage", { chat_id: id, text, disable_web_page_preview: true });
      if (!r?.ok) console.warn(`[driver-live-gate] admin DM to ${id} failed: ${r?.description ?? "unknown"}`);
    } catch (err: any) {
      console.warn(`[driver-live-gate] admin DM to ${id} failed: ${err?.message ?? err}`);
    }
  }
}

let lastRightsWarnAt = 0;
let rightsBlockedUntil = 0;

async function warnMissingRights(api: TgApi): Promise<void> {
  rightsBlockedUntil = Date.now() + RIGHTS_BACKOFF_MS;
  if (Date.now() - lastRightsWarnAt < RIGHTS_BACKOFF_MS) return;
  lastRightsWarnAt = Date.now();
  await notifyAdmins(api, MISSING_RIGHTS_NOTE);
}

async function holdIfProtected(state: LiveGateState, ctx: LiveGateCtx, cfg: LiveGateConfig): Promise<boolean> {
  if (!ctx.dispatchChatId) return true;
  const m = await ctx.api("getChatMember", { chat_id: ctx.dispatchChatId, user_id: state.telegramUserId });
  if (!m.ok) return false;
  const ex = exemptionFor(state.telegramUserId, m.result, cfg.exemptIds);
  if (!ex) return false;
  await setHold(state.telegramUserId);
  console.log(`[driver-live-gate] ${JSON.stringify({ user: state.telegramUserId, action: "hold", exempt: ex })}`);
  return true;
}

async function sendWarning(state: LiveGateState, cfg: LiveGateConfig, ctx: LiveGateCtx): Promise<boolean> {
  if (!ctx.dispatchChatId) return false;
  const mins = graceMinutes(cfg.resumeGraceMs);
  const group = await ctx.api("sendMessage", {
    chat_id: ctx.dispatchChatId,
    text: locationStoppedNotice(state.driverName, mins),
    disable_web_page_preview: true,
  });
  if (!group?.ok) {
    console.error(`[driver-live-gate] warning failed user=${state.telegramUserId}: ${group?.description ?? "unknown"}`);
    return false;
  }
  if (state.liveChatId && state.liveChatId !== String(ctx.dispatchChatId)) {
    const dm = await ctx.api("sendMessage", {
      chat_id: state.liveChatId,
      text: locationStoppedWarning(mins),
      disable_web_page_preview: true,
    });
    if (!dm?.ok) console.warn(`[driver-live-gate] private warning failed user=${state.telegramUserId}: ${dm?.description ?? "unknown"}`);
  }
  return true;
}

async function actOn(state: LiveGateState, cfg: LiveGateConfig, ctx: LiveGateCtx, now: number): Promise<void> {
  const decision: GateAction = decideGateAction(state, now, cfg);
  if (decision.action === "none" || !ctx.dispatchChatId) return;
  if (decision.action === "remove" && now < rightsBlockedUntil) return;
  if (await holdIfProtected(state, ctx, cfg)) return;

  if (decision.action === "warn") {
    const won = await claimWarn(state.telegramUserId, now, state.shareGen);
    if (!won) return;
    const fresh = await loadState(state.telegramUserId);
    if (!fresh || fresh.shareGen !== state.shareGen || fresh.warnedAt !== now) return;
    const sent = await sendWarning(fresh, cfg, ctx);
    if (!sent) await clearWarn(state.telegramUserId, now, state.shareGen);
    else console.log(`[driver-live-gate] ${JSON.stringify({ user: state.telegramUserId, action: "warn", reason: decision.reason })}`);
    return;
  }

  const won = await claimRemove(state.telegramUserId, now, state.shareGen);
  if (!won) return;
  const fresh = await loadState(state.telegramUserId);
  if (!fresh || fresh.shareGen !== state.shareGen || fresh.removedAt !== now) return;

  const kicked = await kickMember(ctx.api, ctx.dispatchChatId, state.telegramUserId, cfg.exemptIds);
  console.log(`[driver-live-gate] ${JSON.stringify({
    user: state.telegramUserId,
    action: "remove",
    reason: decision.reason,
    result: kicked.ok ? "removed" : kicked.why,
  })}`);
  if (kicked.ok) {
    await notifyAdmins(ctx.api, removalNotice(state.driverName, state.telegramUserId, decision.reason));
    return;
  }
  if (kicked.why === "exempt") {
    await setHold(state.telegramUserId);
    return;
  }
  await releaseRemove(state, now);
  if (kicked.why === "no_rights") await warnMissingRights(ctx.api);
}

/** Record a live share or an explicit stop. Static pins are ignored. */
export async function ingestLiveGateLocation(update: any, point: DriverLocationPoint, ctx: LiveGateCtx): Promise<void> {
  const cfg = effectiveLiveGateConfig();
  if (!cfg.enabled || !isMongoConfigured) return;
  const kind = classifyLocationUpdate(update);
  if (!kind || kind === "static") return;
  const now = ctx.now ?? Date.now();
  const prev = await loadState(point.telegramUserId);
  const reduced = reduceLocation(prev, kind, {
    userId: point.telegramUserId,
    driverName: point.driverName,
    at: point.at,
    livePeriod: point.livePeriod,
    liveStartedAt: point.liveStartedAt ?? null,
    lat: point.lat,
    lon: point.lon,
    liveChatId: point.chatId,
    liveMessageId: messageIdOf(update),
  }, now, cfg.staleMs);
  if (!reduced) return;
  const active = reduced.state.isLive && reduced.state.stoppedAt == null;
  await persist(reduced.state, active ? "checkin" : "stop");
  if (reduced.announce && reduced.state.liveChatId) {
    const payload: Record<string, unknown> = {
      chat_id: reduced.state.liveChatId,
      text: checkinReplyText(reduced.state.driverName),
      disable_web_page_preview: true,
    };
    if (reduced.state.liveMessageId != null) payload.reply_to_message_id = reduced.state.liveMessageId;
    const r = await ctx.api("sendMessage", payload);
    if (!r?.ok) console.error(`[driver-live-gate] check-in reply failed user=${point.telegramUserId}: ${r?.description ?? "unknown"}`);
    else console.log(`[driver-live-gate] ${JSON.stringify({ user: point.telegramUserId, action: "checkin" })}`);
  }
  if (!active) await actOn(reduced.state, cfg, ctx, now);
}

/** Approve a join request for the dispatch group and start the share clock. */
export async function ingestJoinRequest(update: any, ctx: LiveGateCtx): Promise<void> {
  const cfg = effectiveLiveGateConfig();
  if (!cfg.enabled || !isMongoConfigured) return;
  const info = parseJoinRequest(update);
  if (!info || info.isBot) return;
  if (!ctx.dispatchChatId || !isDispatchGroupChat(info.chatId, ctx.dispatchChatId)) {
    console.log(`[driver-live-gate] ignored join request for chat ${info.chatId} user=${info.userId}`);
    return;
  }

  let approved = false;
  let description: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await ctx.api("approveChatJoinRequest", { chat_id: ctx.dispatchChatId, user_id: info.userId });
    if (r?.ok || isAlreadyParticipant(r?.description)) {
      approved = true;
      break;
    }
    description = r?.description;
  }
  if (!approved) {
    console.error(`[driver-live-gate] approve join failed user=${info.userId}: ${description ?? "unknown"}`);
    return;
  }

  const now = ctx.now ?? Date.now();
  const prev = await loadState(info.userId);
  const { state, welcome } = applyJoin(prev, info.userId, info.name, now, cfg);
  await persist(state, "join");
  await recordSeen(info.userId, info.username, info.name, false).catch((err) =>
    console.error("[driver-live-gate] seen tracking failed:", err?.message ?? err),
  );
  console.log(`[driver-live-gate] ${JSON.stringify({ user: info.userId, action: "join", welcome, exempt: cfg.exemptIds.has(info.userId) })}`);
  if (!welcome) return;
  const text = joinWelcomeText(info.name, graceMinutes(cfg.joinGraceMs), cfg.exemptIds.has(info.userId));
  const sent = await ctx.api("sendMessage", { chat_id: ctx.dispatchChatId, text, disable_web_page_preview: true });
  if (!sent?.ok) console.error(`[driver-live-gate] welcome failed user=${info.userId}: ${sent?.description ?? "unknown"}`);
}

/** Warn / remove pass. Safe to call on a timer; no-op while the flag is off. */
export async function runLiveGateSweep(ctx: LiveGateCtx): Promise<void> {
  const cfg = effectiveLiveGateConfig();
  if (!cfg.enabled || !ctx.dispatchChatId || !isMongoConfigured) return;
  const now = ctx.now ?? Date.now();
  for (const state of await listStates()) {
    try {
      await actOn(state, cfg, ctx, now);
    } catch (err: any) {
      console.error(`[driver-live-gate] sweep user=${state.telegramUserId} failed:`, err?.message ?? err);
    }
  }
}

let tickerStarted = false;
let sweepBusy = false;

/** Arm the sweep on the update-receiving process. Idempotent. */
export function startLiveGateTicker(getCtx: () => Promise<LiveGateCtx | null>): void {
  if (tickerStarted) return;
  tickerStarted = true;
  console.log("[driver-live-gate] sweep armed on this process (no-op until DRIVER_LIVE_GATE=1)");
  const t = setInterval(() => {
    if (sweepBusy) return;
    sweepBusy = true;
    void (async () => {
      try {
        const ctx = await getCtx();
        if (ctx) await runLiveGateSweep(ctx);
      } catch (err: any) {
        console.error("[driver-live-gate] sweep failed:", err?.message ?? err);
      } finally {
        sweepBusy = false;
      }
    })();
  }, LIVE_GATE_SWEEP_MS);
  (t as { unref?: () => void }).unref?.();
}
