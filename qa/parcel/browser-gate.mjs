export function installPaidTurnGate() {
  const send = WebSocket.prototype.send;
  let grant = false;
  let blocked = 0;
  let sentTurnId = null;
  Object.defineProperty(window, '__parcelQaGate', {
    configurable: false,
    value: {
      grant() { grant = true; sentTurnId = null; },
      revoke() { grant = false; return { blocked, sentTurnId }; },
      state() { return { blocked, sentTurnId }; },
    },
  });
  WebSocket.prototype.send = function (message) {
    if (typeof message === 'string') {
      let parsed;
      try { parsed = JSON.parse(message); } catch { /* The application validates malformed messages. */ }
      if (parsed?.type === 'send_agent_turn' || parsed?.type === 'run_explore_scenario') {
        if (!grant) {
          blocked += 1;
          throw new Error('The QA paid-turn gate is closed.');
        }
        grant = false;
        sentTurnId = parsed.turnId ?? null;
      }
    }
    return send.call(this, message);
  };
}
