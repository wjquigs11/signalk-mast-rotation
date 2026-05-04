/**
 * honey.js - Honeywell mast rotation angle source
 *
 * Connects to a remote host via SSE and subscribes to /mast-events.
 * The endpoint streams mast_angle events at up to 50Hz.
 *
 * Event payload: { mastAngle: <integer degrees> }
 *   Positive = starboard, negative = port, range ~-50 to +50.
 *   Value is 0 when pot reads zero or magnet is out of range.
 */

const http = require('http');

let honeyHost = null;
let honeyPort = 80;
let DEBUG = false;
let VERBOSE = false;

let onMastAngleUpdate = null;
let onConnectionStatusChange = null;

let connected = false;
let reconnectTimer = null;
let activeRequest = null;

function init(config) {
  honeyHost = config.honeyHost;
  honeyPort = config.honeyPort || 80;
  DEBUG = config.debug || false;
  VERBOSE = config.verbose || false;
  onMastAngleUpdate = config.onMastAngleUpdate || null;
  onConnectionStatusChange = config.onConnectionStatusChange || null;
}

function connect() {
  if (!honeyHost) {
    console.error('[honey] No host specified');
    return;
  }

  console.log(`[honey] Connecting to SSE at http://${honeyHost}:${honeyPort}/mast-events`);

  const options = {
    hostname: honeyHost,
    port: honeyPort,
    path: '/mast-events',
    method: 'GET',
    headers: {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache'
    }
  };

  const req = http.request(options, (res) => {
    if (res.statusCode !== 200) {
      console.error(`[honey] SSE endpoint returned HTTP ${res.statusCode}`);
      res.resume();
      scheduleReconnect();
      return;
    }

    console.log(`[honey] SSE stream connected`);
    connected = true;
    if (onConnectionStatusChange) onConnectionStatusChange(true);

    let buffer = '';

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

      let eventName = null;
      let eventData = null;

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          eventData = line.slice(5).trim();
        } else if (line === '') {
          // blank line = end of event
          if (eventName === 'mast_angle' && eventData) {
            try {
              const { mastAngle } = JSON.parse(eventData);
              const radians = mastAngle * Math.PI / 180;
              if (VERBOSE) {
                console.log(`[honey] mastAngle: ${mastAngle}° (${radians.toFixed(4)} rad)`);
              }
              if (onMastAngleUpdate) onMastAngleUpdate(radians);
            } catch (e) {
              if (DEBUG) console.error(`[honey] Parse error: ${e.message} — data: ${eventData}`);
            }
          }
          eventName = null;
          eventData = null;
        }
      }
    });

    res.on('end', () => {
      console.log('[honey] SSE stream ended');
      connected = false;
      if (onConnectionStatusChange) onConnectionStatusChange(false);
      scheduleReconnect();
    });

    res.on('error', (err) => {
      console.error(`[honey] Stream error: ${err.message}`);
      connected = false;
      if (onConnectionStatusChange) onConnectionStatusChange(false);
      scheduleReconnect();
    });
  });

  req.on('error', (err) => {
    console.error(`[honey] Connection error: ${err.message}`);
    connected = false;
    if (onConnectionStatusChange) onConnectionStatusChange(false);
    scheduleReconnect();
  });

  req.end();
  activeRequest = req;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log('[honey] Reconnecting in 5 seconds...');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
}

function start() {
  connect();
}

function stop() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (activeRequest) {
    try { activeRequest.destroy(); } catch (e) {}
    activeRequest = null;
  }
  connected = false;
}

function isConnected() {
  return connected;
}

module.exports = {
  init,
  start,
  stop,
  isConnected
};
