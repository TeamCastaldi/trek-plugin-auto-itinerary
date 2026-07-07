const FLIGHT_KEYWORDS = ['flight', 'airline', 'pnr', 'boarding pass', 'e-ticket'];
const TRAIN_KEYWORDS = ['train', 'rail', 'amtrak', 'eurostar'];
const HOTEL_KEYWORDS = ['hotel', 'check-in', 'check in', 'check-out', 'checkout', 'lodging'];

function matchesAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

/**
 * Classifies a normalized event by keyword heuristic on summary/description, per docs/PLAN.md §3.
 * Falls back to a generic reservation so no invite is ever dropped.
 */
function classifyEvent(event) {
  const text = `${event.summary} ${event.description}`.toLowerCase();

  let type = 'reservation';
  if (matchesAny(text, FLIGHT_KEYWORDS)) {
    type = 'flight';
  } else if (matchesAny(text, TRAIN_KEYWORDS)) {
    type = 'train';
  } else if (matchesAny(text, HOTEL_KEYWORDS)) {
    type = 'hotel';
  }

  return { type, event };
}

module.exports = { classifyEvent };
