const {
  computeTripDateRange,
  transportTypeForClassification,
  buildCreateTripPayload,
  buildCreatePlacePayload,
  buildCreateAccommodationPayload,
  buildCreateTransportPayload,
  buildCreateReservationPayload,
  buildCreateShareLinkPayload,
} = require('./payloads');

/**
 * Drops cancelled events from a message's classified events (per-event `METHOD:CANCEL`/
 * `STATUS:CANCELLED`, per docs/PLAN.md §3). Detecting/handling the cancellation of a
 * *previously created* trip/entity requires the ledger and is TODO M4's job — this is only the
 * "don't build something for an already-cancelled invite" guard.
 */
function filterActiveEvents(classifiedEvents) {
  return classifiedEvents.filter(({ event }) => !event.cancelled);
}

/**
 * Best-effort check (never throws) that a payload's top-level keys appear in the tool's live
 * `inputSchema` properties, so a wrong SCHEMA-GUESS in payloads.js surfaces as a log line instead
 * of a silent bad request.
 */
function schemaWarning(toolsMap, toolName, payload) {
  try {
    const schema = toolsMap && toolsMap.get(toolName);
    const properties = schema && schema.properties;
    if (!properties) return null;

    const missing = Object.keys(payload).filter(
      (key) => payload[key] !== undefined && !(key in properties)
    );
    if (!missing.length) return null;

    return {
      step: 'schema-check',
      tool: toolName,
      ok: false,
      error: `guessed field(s) not present in live inputSchema: ${missing.join(', ')}`,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Builds one TREK trip for one invite (email message), folding all of its non-cancelled VEVENTs
 * into that single trip per docs/PLAN.md's locked "one invite -> one trip" decision. A failure in
 * any create_* call throws immediately — no partial-continue-anyway logic; a partially-built trip
 * on failure is an accepted, visible gap until TODO M4's ledger/reconciliation lands.
 */
async function buildTripForMessage(session, message, classifiedEvents, config) {
  const trace = [];
  if (!classifiedEvents.length) {
    return { tripId: null, shareUrl: null, entityCount: 0, trace };
  }

  const toolsMap = await session.listTools();

  function record(toolName, payload) {
    const warning = schemaWarning(toolsMap, toolName, payload);
    if (warning) trace.push(warning);
  }

  const events = classifiedEvents.map(({ event }) => event);
  const { startDate, endDate } = computeTripDateRange(events);
  const tripPayload = buildCreateTripPayload({ title: events[0].summary, startDate, endDate });
  record('create_trip', tripPayload);

  const tripResult = await session.callTool('create_trip', tripPayload);
  // SCHEMA-GUESS: exact result field name for the created trip's id is unverified.
  const tripId = tripResult && tripResult.tripId;
  trace.push({ step: 'create_trip', tool: 'create_trip', ok: true });

  let entityCount = 0;
  for (const { type, event } of classifiedEvents) {
    let placeId;
    if (event.location) {
      const placePayload = buildCreatePlacePayload({
        name: event.location,
        tripId,
        date: event.start,
        allDay: event.allDay,
      });
      record('create_and_assign_place', placePayload);
      const placeResult = await session.callTool('create_and_assign_place', placePayload);
      // SCHEMA-GUESS: exact result field name for the created place's id is unverified.
      placeId = placeResult && placeResult.placeId;
      trace.push({ step: 'create_and_assign_place', tool: 'create_and_assign_place', ok: true });
    }

    let tool;
    let payload;
    if (type === 'flight' || type === 'train') {
      tool = 'create_transport';
      payload = buildCreateTransportPayload({
        tripId,
        placeId,
        event,
        transportType: transportTypeForClassification(type),
      });
    } else if (type === 'hotel') {
      tool = 'create_accommodation';
      payload = buildCreateAccommodationPayload({ tripId, placeId, event });
    } else {
      tool = 'create_reservation';
      payload = buildCreateReservationPayload({ tripId, placeId, event });
    }

    record(tool, payload);
    await session.callTool(tool, payload);
    trace.push({ step: tool, tool, ok: true });
    entityCount += 1;
  }

  let shareUrl = null;
  if (config.auto_share === 'yes') {
    const shareLinkPayload = buildCreateShareLinkPayload({ tripId });
    record('create_share_link', shareLinkPayload);
    const shareResult = await session.callTool('create_share_link', shareLinkPayload);
    // SCHEMA-GUESS: exact result field name for the share URL is unverified.
    shareUrl = shareResult && shareResult.url;
    trace.push({ step: 'create_share_link', tool: 'create_share_link', ok: true });
  }

  return { tripId, shareUrl, entityCount, trace };
}

module.exports = { filterActiveEvents, buildTripForMessage };
